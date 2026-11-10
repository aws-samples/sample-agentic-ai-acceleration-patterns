<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Script conventions

- `set -euo pipefail`, never `set -x`. Scripts print step names, HTTP
  statuses, and resource names, never tokens, passwords, or memory content.
- Bearer tokens and passwords live in shell variables or process memory
  only; they are never written to files, arguments of other processes'
  logs, or reports.
- Every script that creates something removes it from an exit trap, also on
  failure: `demo.sh` deletes its users, `integ.sh` destroys the stack and
  proves the teardown.
- Each script runs in exactly one Region, `AWS_REGION`, and fails fast when
  it is unset.
- A negative Gateway probe passes only on the status it names (403 for a
  Policy denial, 401 for an expired token); any other status fails it.
