# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# The driver's 429 count per tenant, from a k6 summary (P-7, attribute.jq's $caps).
#
#   jq -c -f caps.jq <k6 summary>
#
# probe.js buildOptions sets one always-passing threshold per tenant on the tagged counter,
# so the summary holds a `tenant_429{tenant:<id>}` sub-metric for each, in the handleSummary
# layout (`.values.count`) or the summary-export layout (`.count`). The answer is
# {"<tenant id>": <count>}; a summary without them is {}, which caps every tenant at 0.

(.metrics // {})
| to_entries
| map(select(.key | test("^tenant_429\\{tenant:[^}]+\\}$"))
      | {key: (.key | capture("^tenant_429\\{tenant:(?<t>[^}]+)\\}$").t),
         value: ((.value.values // .value).count // 0)})
| from_entries
