# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Shared prelude of the integration test's probe scripts (spec section 8).
# The driver puts `CONFIG = {...}` and this file in front of each probe, because
# the runner starts jobs with `python3 -I -S` (no site directory, no module
# search path beyond the standard library, current directory not importable).
# Only the standard library is used. Each probe records its observations in
# `R` and ends with `done()`, which prints one JSON line; the driver reads the
# last JSON line of stdout. A probe never prints a credential or a token.

import errno as _errno
import hashlib
import hmac
import json
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

R = {}


def done():
    sys.stdout.write("\n" + json.dumps(R, sort_keys=True) + "\n")
    sys.stdout.flush()


def attempt(name, fn):
    """Run fn; record {ok: True, v: value} or {ok: False, err: class, errno: n}."""
    try:
        R[name] = {"ok": True, "v": fn()}
    except BaseException as e:  # noqa: BLE001 - a probe records every failure
        R[name] = {"ok": False, "err": type(e).__name__, "errno": getattr(e, "errno", None)}


def llink():
    # The link-local metadata address, built from parts.
    return ".".join(["169", "254", "169", "254"])


PROBE_TIMEOUT = 2
LOOKUP_TIMEOUT = 10


class ProbeDeadline(socket.timeout):
    """No TCP connect within the deadline: the path gave no answer, which a blocked path must give."""


class ProbeConnected(Exception):
    """The TCP connect completed, then no answer came in time (or the request failed): the path is open, never blocked."""


class ProbeLookupSlow(Exception):
    """The name lookup neither answered nor failed within LOOKUP_TIMEOUT: nothing is known, so never blocked."""


def _bounded(fn, timeout):
    """Runs fn in a thread for at most `timeout` seconds. Returns (True, value), (False, error), or None when still running."""
    box = []

    def go():
        try:
            box.append((True, fn()))
        except BaseException as e:  # noqa: BLE001 - handed to the caller
            box.append((False, e))

    t = threading.Thread(target=go, daemon=True)
    t.start()
    t.join(timeout)
    return box[0] if box else None


def _resolve(url):
    """The first TCP address of the URL's host and port. A failed lookup (gaierror) is raised; a slow one is ProbeLookupSlow."""
    u = urllib.parse.urlsplit(url)
    port = u.port or (443 if u.scheme == "https" else 80)
    got = _bounded(lambda: socket.getaddrinfo(u.hostname, port, socket.AF_UNSPEC, socket.SOCK_STREAM), LOOKUP_TIMEOUT)
    if got is None:
        raise ProbeLookupSlow("no lookup answer within " + str(LOOKUP_TIMEOUT) + " s")
    if not got[0]:
        raise got[1]
    family, kind, proto, _name, addr = got[1][0]
    return family, kind, proto, addr


def _connect(target, timeout):
    family, kind, proto, addr = target
    s = socket.socket(family, kind, proto)
    s.settimeout(timeout)
    try:
        s.connect(addr)
    finally:
        s.close()


def _request(method, url, headers, body, timeout):
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(65536)
    except urllib.error.HTTPError as e:
        return e.code, e.read(4096)


def http(method, url, headers=None, body=None, timeout=PROBE_TIMEOUT):
    """One HTTP request; returns (status, bytes). A refusal status is data, not an error.

    Three steps. The name lookup gets LOOKUP_TIMEOUT seconds: a lookup that fails (no such name, a
    firewall answer) is raised and means blocked; one that gives no answer in time raises
    ProbeLookupSlow, which no check counts as blocked. Then a TCP connect to the first address,
    bounded to `timeout` seconds: a connect that fails or does not complete in time (ProbeDeadline)
    means the path is blocked. Only then the request itself, also bounded to `timeout` seconds
    (urllib's own timeout is per address): no answer in time, or a failure after the connect, raises
    ProbeConnected, which no check counts as blocked. So a slow but open path (a cold resolver, a
    cold TLS handshake through a NAT, a slow endpoint) never passes a negative check by its slowness.
    """
    target = _resolve(url)
    first = _bounded(lambda: _connect(target, timeout), timeout)
    if first is None:
        raise ProbeDeadline("no connect within the deadline")
    if not first[0]:
        raise first[1]
    second = _bounded(lambda: _request(method, url, headers, body, timeout), timeout)
    if second is None:
        raise ProbeConnected("connected, then no answer within the deadline")
    if not second[0]:
        raise ProbeConnected("connected, then " + type(second[1]).__name__)
    return second[1]


def imds_credentials():
    """Credentials through the metadata service (token flow), or None. Never printed."""
    base = "http://" + llink()
    st, tok = http("PUT", base + "/latest/api/token", {"X-aws-ec2-metadata-token-ttl-seconds": "60"})
    if st != 200:
        return None
    h = {"X-aws-ec2-metadata-token": tok.decode()}
    st, role = http("GET", base + "/latest/meta-data/iam/security-credentials/", h)
    if st != 200 or not role.strip():
        return None
    st, body = http("GET", base + "/latest/meta-data/iam/security-credentials/" + role.decode().split()[0], h)
    if st != 200:
        return None
    c = json.loads(body)
    return {"ak": c["AccessKeyId"], "sk": c["SecretAccessKey"], "st": c.get("Token", "")}


def _hmac(key, msg):
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def sigv4(method, host, path, region, service, creds, body=b"", query="", extra=None):
    """Sign with SigV4 (header form). Returns the header dict."""
    now = time.gmtime()
    amz = time.strftime("%Y%m%dT%H%M%SZ", now)
    day = time.strftime("%Y%m%d", now)
    payload = hashlib.sha256(body).hexdigest()
    hdrs = {"host": host, "x-amz-content-sha256": payload, "x-amz-date": amz}
    if creds.get("st"):
        hdrs["x-amz-security-token"] = creds["st"]
    hdrs.update({k.lower(): v for k, v in (extra or {}).items()})
    names = sorted(hdrs)
    canon = "\n".join(
        [method, path, query, "".join(k + ":" + hdrs[k].strip() + "\n" for k in names), ";".join(names), payload]
    )
    scope = day + "/" + region + "/" + service + "/aws4_request"
    sts = "\n".join(["AWS4-HMAC-SHA256", amz, scope, hashlib.sha256(canon.encode()).hexdigest()])
    k = _hmac(("AWS4" + creds["sk"]).encode(), day)
    for part in (region, service, "aws4_request"):
        k = _hmac(k, part)
    sig = hmac.new(k, sts.encode(), hashlib.sha256).hexdigest()
    out = {k2: v for k2, v in hdrs.items() if k2 != "host"}
    out["Authorization"] = (
        "AWS4-HMAC-SHA256 Credential=" + creds["ak"] + "/" + scope
        + ", SignedHeaders=" + ";".join(names) + ", Signature=" + sig
    )
    return out


def s3_request(method, key, creds, body=b"", timeout=PROBE_TIMEOUT):
    host = CONFIG["bucket"] + ".s3." + CONFIG["region"] + ".amazonaws.com"
    path = "/" + "/".join(urllib.parse.quote(p, safe="") for p in key.split("/"))
    h = sigv4(method, host, path, CONFIG["region"], "s3", creds, body)
    return http(method, "https://" + host + path, h, body or None, timeout=timeout)


def tcp_connect(host, port, timeout=PROBE_TIMEOUT):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect((host, port))
        return True
    finally:
        s.close()


def errno_name(code):
    return _errno.errorcode.get(code, str(code))

