# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Step no-egress: HTTPS to a public name, a TCP connect to a public address
# with no name lookup (so the route and the security group are tested even
# when the firewall answers the name first), TCP to tenant B's sandbox
# address, and a presigned PUT to a bucket outside the endpoint policy. Every
# probe must fail within 2 s (no TCP connect: ProbeDeadline or a connect error),
# and the IP-literal connect must not complete.
import threading


def probe(name, fn):
    def go():
        t0 = time.time()
        try:
            R[name] = {"outcome": fn()}
        except BaseException as e:  # noqa: BLE001
            R[name] = {"error": type(e).__name__, "errno": getattr(e, "errno", None)}
        R[name]["ms"] = int((time.time() - t0) * 1000)
    t = threading.Thread(target=go)
    t.start()
    return t


def https_name():
    return http("GET", "https://example.com/")[0]


def tcp_public():
    return "connected" if tcp_connect(CONFIG["public_ip"], 443) else "refused"


def tcp_peer():
    return "connected" if tcp_connect(CONFIG["peer_ip"], CONFIG["peer_port"]) else "refused"


def put_presigned():
    return http("PUT", CONFIG["presigned"], {}, b"x")[0]


def https_peer():
    return http("GET", CONFIG["peer_url"])[0]


ts = [probe("https_name", https_name), probe("tcp_public_ip", tcp_public), probe("put_presigned", put_presigned)]
if CONFIG.get("peer_ip"):
    ts.append(probe("tcp_peer", tcp_peer))
if CONFIG.get("peer_url"):
    ts.append(probe("https_peer", https_peer))
for t in ts:
    t.join(5)
done()
