# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Step session-files (agentcore, sessionFiles on). The session id is
# "rc-" + hex SHA-256 of the tenant id (ADR-0009). CONFIG["mode"]:
#   write   PutObject sessions/<own sid>/note.txt with the runtime role
#   read    GetObject on the same key, and report whether the body matches
#   deny    GetObject on the other tenant's session prefix (must be refused)
creds = imds_credentials()
R["credentials_loaded"] = creds is not None


def sid(tenant):
    return "rc-" + hashlib.sha256(tenant.encode()).hexdigest()


if creds is not None:
    own = "sessions/" + sid(CONFIG["tenant"]) + "/note.txt"
    if CONFIG["mode"] == "write":
        attempt("put", lambda: s3_request("PUT", own, creds, CONFIG["value"].encode())[0])
    elif CONFIG["mode"] == "read":
        def get():
            status, body = s3_request("GET", own, creds)
            return {"status": status, "match": body.decode(errors="replace") == CONFIG["value"]}
        attempt("get", get)
    else:
        attempt("get_other", lambda: s3_request("GET", "sessions/" + sid(CONFIG["other"]) + "/note.txt", creds)[0])
done()
