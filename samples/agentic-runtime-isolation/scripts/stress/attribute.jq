# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# P-7 for one scenario (docs/stress-test.spec.md §2, ADR-0052): which refusals
# the hops' logs attribute to a tenant, and how many the driver saw that no log
# line accounts for.
#
#   jq -n --argjson seen <4xx and 5xx the driver saw> --argjson caps <{tenantId: 429s}> \
#     --slurpfile rows <rows.json> -f attribute.jq
#
# rows.json is the Logs Insights result of
#   filter message = "request refused" | stats count(*) as n by tenantId, reason, status
# over the authoriser and ingress log groups, as an array of objects (n and status are
# strings, as Insights returns them). Only a row with a tenantId attributes a
# refusal. caps is the driver's own 429 count per tenant (`tenant_429{tenant:<id>}`
# in the k6 summary); a tenant missing from it counts 0. The answer is the
# `refusals` field of a result record:
#   byTenantReason: the logged refusals by tenant and reason, as logged
#   unattributed:   what the driver saw beyond the credited lines, never below 0
#
# The match is by count, not per request: the slice does not yet join on the
# correlationId the ingress logs (ADR-0053, ADR-0052's revisit trigger). A log can
# hold more lines than the driver saw: the query window is wider than the
# scenario's, so a request at its edge is logged and not counted.
# Excess lines could offset a refusal no line explains. Each tenant's 429 lines are
# therefore credited at most up to the driver's 429 count for that tenant, so one
# tenant's excess 429 lines cannot hide another tenant's unattributed refusal. Lines
# with another status are credited as logged: the driver has no per-tenant count for
# them, so an excess there can still offset an unattributed refusal.

def num: tonumber? // 0;
def reason: if (.reason // "") == "" then "unknown" else .reason end;
def is429: (.status // "" | tostring) == "429";

($rows[0] | map(select((.tenantId // "") != ""))) as $named
| ($named
   | group_by(.tenantId)
   | map(
       .[0].tenantId as $t
       | (map(select(is429) | .n | num) | add // 0) as $r429
       | (map(select(is429 | not) | .n | num) | add // 0) as $other
       | ([$r429, ($caps[$t] // 0)] | min) + $other)
   | add // 0) as $credited
| {
    byTenantReason: (
      $named
      | group_by([.tenantId, reason])
      | map({tenant: .[0].tenantId, reason: (.[0] | reason), count: (map(.n | num) | add)})
      | sort_by(.tenant, .reason)
    ),
    unattributed: ([$seen - $credited, 0] | max)
  }
