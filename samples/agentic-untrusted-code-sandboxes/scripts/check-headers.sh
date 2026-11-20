#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# License header check for files eslint does not see (standard 4.1,
# ADR-0026): every authored Python file, Dockerfile and shell script
# carries the two-line MIT-0 header in its first five lines. TypeScript is
# covered by review and ProtoShield's license-headers plugin.
set -euo pipefail

cd "$(dirname "$0")/.."

files=$(git ls-files --cached --others --exclude-standard -- \
  '*.py' '**/Dockerfile' 'Dockerfile' '*.sh' ':!:node_modules/**' ':!:lib/**' ':!:cdk.out/**')

missing=0
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  head_text=$(head -n 5 -- "$f")
  if ! grep -q 'Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.' <<< "$head_text" \
    || ! grep -q 'SPDX-License-Identifier: MIT-0' <<< "$head_text"; then
    echo "check-headers: missing MIT-0 header: $f"
    missing=1
  fi
done <<< "$files"

if [[ "$missing" -ne 0 ]]; then
  exit 1
fi
echo "check-headers: ok"
