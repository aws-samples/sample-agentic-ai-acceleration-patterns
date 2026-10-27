<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Script conventions

Run Python modules from the sample root. Read bearer tokens from environment
variables without echoing them, logging them, or using shell tracing. Keep real
configuration in ignored `live-config.json`. Print test names and status only.
Treat every HTTP error except an observed 403 authorization denial as a failed
negative test. Expired-token validation also accepts an observed 401.

Configuration generation and dry-run validation make no AWS calls.
