# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# P-7 for one platform-mode scenario (docs/stress-test.spec.md §2, §5.1): the refusals the
# driver saw through the edge, by tenant and reason, and how many it cannot attribute.
#
#   jq -n --argjson seen <4xx and 5xx and refusals inside a 200 the driver saw> \
#     --slurpfile lines <lines.json> -f attribute-edge.jq
#
# lines.json is the JSON lines k6 printed (`<script>.k6-stdout.txt`), as an array:
#   {"kind": "edge_refusal", "epochMinute", "tenantId", "status"}   one per refused request (the
#                                                                   minute is for a reader of the output)
#   {"kind": "body_refusal", "tenantId", "reason"}            one per refusal inside a 200
# The answer is the `refusals` field of a result record. A status refusal's reason is
# `http-<status>`: the edge and the cells' own logs are not joined in platform mode, so the
# reason is the status the client saw (collect-platform.sh, stress/README.md).
#   byTenantReason: the counted refusals by tenant and reason, the largest first
#   unattributed:   what the driver saw beyond the counted lines, never below 0

(
  [$lines[0][] | select(.kind == "edge_refusal" and (.tenantId | type) == "string" and (.status | type) == "number")
    | {tenant: .tenantId, reason: "http-\(.status)", count: 1}]
  + [$lines[0][] | select(.kind == "body_refusal" and (.tenantId | type) == "string" and (.reason | type) == "string")
    | {tenant: .tenantId, reason: .reason, count: 1}]
) as $rows
| ($rows | group_by([.tenant, .reason]) | map({tenant: .[0].tenant, reason: .[0].reason, count: (map(.count) | add)})
    | sort_by(-.count, .tenant, .reason)) as $by
| ($by | map(.count) | add // 0) as $credited
| {byTenantReason: $by, unattributed: ([$seen - $credited, 0] | max)}
