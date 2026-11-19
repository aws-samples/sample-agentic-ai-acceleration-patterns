# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# P-7 for one scenario (docs/stress-test.spec.md §2, ADR-0052): which refusals
# the hops' logs attribute to a tenant, and how many the driver saw that no log
# line accounts for.
#
#   jq -n --argjson seen <4xx and 5xx the driver saw> --slurpfile rows <rows.json> -f attribute.jq
#
# rows.json is the Logs Insights result of
#   filter message = "request refused" | stats count(*) as n by tenantId, reason
# over the authoriser and ingress log groups, as an array of objects (n is a
# string, as Insights returns it). Only a row with a tenantId attributes a
# refusal. The answer is the `refusals` field of a result record:
#   byTenantReason: the logged refusals by tenant and reason
#   unattributed:   what the driver saw beyond them, never below 0
#
# A log can hold more lines than the driver saw: a request in flight at the
# window's edge is logged by the hop and not counted by the driver. That adds to
# byTenantReason and never hides an unattributed refusal.

def num: tonumber? // 0;
def reason: if (.reason // "") == "" then "unknown" else .reason end;

($rows[0] | map(select((.tenantId // "") != ""))) as $named
| ($named | map(.n | num) | add // 0) as $logged
| {
    byTenantReason: (
      $named
      | group_by([.tenantId, reason])
      | map({tenant: .[0].tenantId, reason: (.[0] | reason), count: (map(.n | num) | add)})
      | sort_by(.tenant, .reason)
    ),
    unattributed: ([$seen - $logged, 0] | max)
  }
