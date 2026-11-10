<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Script conventions

Run Python modules from the sample root. Read bearer tokens from environment
variables without echoing them, logging them, or using shell tracing. Keep real
configuration in ignored `live-config.json`. Print test names and status only.
A negative Gateway probe passes only on an observed 403 authorization denial;
every other HTTP error fails it. The expired-token probe passes only on 401.
A probe that cannot prove what it names is recorded `NOT_RUN`, never `PASS`.

Configuration generation and dry-run validation make no AWS calls.
