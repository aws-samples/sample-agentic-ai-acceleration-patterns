# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Step no-egress: HTTPS to a public name, a TCP connect to a public address
# with no name lookup (so the route and the security group are tested even
# when the firewall answers the name first), TCP to tenant B's sandbox
# address, and a presigned PUT to a bucket outside the endpoint policy. Every
# probe must make no TCP connection (a failed lookup or connect, or ProbeDeadline
# after 2 s), except the presigned PUT on agentcore, which reaches S3 and must get
# 403. A positive control to an allowed address must get a status in the same time.
import resource
import threading


def probe(name, fn):
    t0 = time.time()
    try:
        R[name] = {"outcome": fn()}
    except BaseException as e:  # noqa: BLE001
        R[name] = {"error": type(e).__name__, "errno": getattr(e, "errno", None)}
    R[name]["ms"] = int((time.time() - t0) * 1000)


def workers():
    # RLIMIT_NPROC counts every thread of the job (9 on microvm at the default size, 64 elsewhere). A probe starts at
    # most one helper thread at a time (_bounded in _lib.py) and leaves at most one behind when it gives up, and four
    # probes use helpers, so main + (soft - 2) // 2 workers + four helpers stays under the limit.
    soft = resource.getrlimit(resource.RLIMIT_NPROC)[0]
    return len(PROBES) if soft == resource.RLIM_INFINITY else max(1, min(len(PROBES), (soft - 2) // 2))


def run_all():
    todo = list(PROBES)
    lock = threading.Lock()

    def work():
        while True:
            with lock:
                if not todo:
                    return
                name, fn = todo.pop(0)
            probe(name, fn)

    ts = [threading.Thread(target=work, daemon=True) for _ in range(workers())]
    for t in ts:
        t.start()
    return ts


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


def control():
    # The positive control: the same request code and deadline against an address the sandbox may reach (the
    # metadata service on microvm and agentcore, the ECS credentials path on nitro). Any status is an answer.
    if CONFIG["backend"] == "nitro":
        return http("GET", "http://" + ".".join(["169", "254", "170", "2"]) + "/v2/credentials/none")[0]
    return http("GET", "http://" + llink() + "/latest/meta-data/")[0]


# The slow probes first (a name that resolves, then up to four connects), so a small pool still ends in time.
PROBES = [("control", control), ("https_name", https_name), ("put_presigned", put_presigned)]
if CONFIG.get("peer_url"):
    PROBES.append(("https_peer", https_peer))
PROBES.append(("tcp_public_ip", tcp_public))
if CONFIG.get("peer_ip"):
    PROBES.append(("tcp_peer", tcp_peer))
# A lookup may take LOOKUP_TIMEOUT before the connects and the request; the workers run side by side on one deadline.
join_all(run_all())
done()
