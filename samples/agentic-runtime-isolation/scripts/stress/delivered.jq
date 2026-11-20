# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# S3's delivery check (design/agentic-runtime-isolation.stress-test.md §4): the steady VUs
# sent at least 95 % of steadyRps x seconds.
#
#   jq -c -f delivered.jq <S3's k6 summary>
#
# s3-noisy.js counts, in the summary (summary-export or handleSummary layout):
#   steady_expected                    steadyRps x seconds, added once in setup()
#   steady_sent                        requests the steady VUs sent in the timed scenario
#   iteration_skipped{reason:behind}   requests a VU (steady or noisy) skipped because it fell behind
# The answer: sent, expected, behind, shortPct (how far under expected, %, one decimal), and
# pass (expected above 0, and at most 5 % short before rounding). A missing counter is 0, so a
# summary without them fails.

def count($k): ((.metrics // {})[$k] // {}) | ((.values // .).count // 0);

count("steady_expected") as $expected
| count("steady_sent") as $sent
| (if $expected > 0 then ($expected - $sent) / $expected * 100 else 100 end) as $short
| {
    sent: $sent,
    expected: $expected,
    behind: count("iteration_skipped{reason:behind}"),
    shortPct: ([($short * 10 | round) / 10, 0] | max),
    pass: ($expected > 0 and $short <= 5),
  }
