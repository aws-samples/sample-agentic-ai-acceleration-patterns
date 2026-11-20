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


def _request(method, url, headers, body, timeout):
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(65536)
    except urllib.error.HTTPError as e:
        return e.code, e.read(4096)


def http(method, url, headers=None, body=None, timeout=PROBE_TIMEOUT):
    """One HTTP request; returns (status, bytes). A refusal status is data, not an error.

    The whole request gets at most PROBE_TIMEOUT seconds, however many addresses the name has
    (urllib's timeout is per address). A request still open then is a timeout, which a blocked
    path must give: the probes stay well inside the run timeout on a sandbox with no route.
    """
    timeout = min(timeout, PROBE_TIMEOUT)
    box = []

    def go():
        try:
            box.append(_request(method, url, headers, body, timeout))
        except BaseException as e:  # noqa: BLE001 - handed to the caller
            box.append(e)

    t = threading.Thread(target=go, daemon=True)
    t.start()
    t.join(timeout)
    if not box:
        raise socket.timeout("probe deadline")
    if isinstance(box[0], BaseException):
        raise box[0]
    return box[0]


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


def s3_request(method, key, creds, body=b""):
    host = CONFIG["bucket"] + ".s3." + CONFIG["region"] + ".amazonaws.com"
    path = "/" + "/".join(urllib.parse.quote(p, safe="") for p in key.split("/"))
    h = sigv4(method, host, path, CONFIG["region"], "s3", creds, body)
    return http(method, "https://" + host + path, h, body or None)


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

