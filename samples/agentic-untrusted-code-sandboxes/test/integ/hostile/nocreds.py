# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Step no-credentials: tenant A's script looks for credentials in every place a
# program would (the metadata service, the container credential paths, the
# environment, a credentials file, the SDK) and then tries tenant B's invoice
# and registry row. It reports statuses and booleans only, never a value.
import threading

R["boto3_importable"] = False
try:
    import boto3  # noqa: F401  (-I -S: no site directory, so this must fail)
    R["boto3_importable"] = True
except ImportError:
    pass
R["env_credentials"] = any(k in os.environ for k in ("AWS_ACCESS_KEY_ID", "AWS_SESSION_TOKEN", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI"))
R["credentials_file"] = os.path.exists(os.path.expanduser("~/.aws/credentials"))
creds = [None]


def probe(name, fn):
    def go():
        t0 = time.time()
        try:
            R[name] = {"status": fn()}
        except BaseException as e:  # noqa: BLE001
            R[name] = {"error": type(e).__name__}
        R[name]["ms"] = int((time.time() - t0) * 1000)
    t = threading.Thread(target=go)
    t.start()
    return t


def role_path():
    # Without the token flow, then with it: a service that wants the token answers 401 to the first
    # and what it holds (404 on a MicroVM without an execution role) to the second.
    base = "http://" + llink() + "/latest/meta-data/iam/security-credentials/"
    tokenless = http("GET", base)[0]
    st, tok = http("PUT", "http://" + llink() + "/latest/api/token", {"X-aws-ec2-metadata-token-ttl-seconds": "60"})
    with_token = http("GET", base, {"X-aws-ec2-metadata-token": tok.decode()})[0] if st == 200 else None
    R["imds_role_path_with_token"] = {"status": with_token, "token_status": st}
    return tokenless


def ecs_path():
    return http("GET", "http://" + ".".join(["169", "254", "170", "2"]) + "/v2/credentials/none")[0]


def load():
    creds[0] = imds_credentials()
    return creds[0] is not None


early = [probe("imds_role_path", role_path), probe("ecs_credentials_path", ecs_path), probe("imds_credentials_loaded", load)]
for t in early:
    t.join(6)
R["credentials_loaded"] = creds[0] is not None


def get_b():
    key = "inputs/" + CONFIG["other"] + "/invoice.csv"
    if creds[0]:
        return s3_request("GET", key, creds[0])[0]
    return http("GET", "https://" + CONFIG["bucket"] + ".s3." + CONFIG["region"] + ".amazonaws.com/" + key)[0]


def get_row_b():
    host = "dynamodb." + CONFIG["region"] + ".amazonaws.com"
    body = json.dumps({"TableName": CONFIG["table"], "Key": {"PK": {"S": "TENANT#" + CONFIG["other"]}, "SK": {"S": "SANDBOX#" + CONFIG["backend"]}}}).encode()
    c = creds[0] or {"ak": "AKIAIOSFODNN7EXAMPLE", "sk": "x", "st": ""}
    h = sigv4("POST", host, "/", CONFIG["region"], "dynamodb", c, body, extra={"Content-Type": "application/x-amz-json-1.0", "X-Amz-Target": "DynamoDB_20120810.GetItem"})
    return http("POST", "https://" + host + "/", h, body)[0]


late = [probe("get_object_b", get_b), probe("get_row_b", get_row_b)]
for t in late:
    t.join(6)
done()
