# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# S3's noisy-neighbour criterion (stress-test plan §5): the noisy tenant is refused
# 429 and no other tenant is.
#
#   jq -n --arg noisy <noisy tenant id, "" when unknown> --slurpfile rows <insights-refused_429.json> -f noisy.jq
#
# rows is the Logs Insights result `stats count(*) as n by tenantId, bin(1m)` of the
# ingress's 429 lines. The answer holds counts only, never a tenant id:
#   noisy429:     429s for the noisy tenant
#   others429:    429s for any other tenant, untagged lines included
#   otherTenants: how many other tenants got one
#   pass:         noisy tenant known, refused at least once, and others429 is 0

def num: tonumber? // 0;

($rows[0] // []) as $r
| ($r | map(select($noisy != "" and .tenantId == $noisy))) as $hit
| ($r | map(select($noisy == "" or .tenantId != $noisy))) as $rest
| ($hit | map(.n | num) | add // 0) as $mine
| {
    noisy429: $mine,
    others429: ($rest | map(.n | num) | add // 0),
    otherTenants: ($rest | map(.tenantId // "") | unique | length),
  }
| .pass = ($noisy != "" and .noisy429 > 0 and .others429 == 0)
