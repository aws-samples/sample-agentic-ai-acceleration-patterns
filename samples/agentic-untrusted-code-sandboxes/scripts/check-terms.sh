#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Terminology and public-repository check (standard 4.4, ADR-0026): the
# sample says "vendor" and "tenant", and carries no account id or account
# alias. Runs in `npx projen test` from the sample root over tracked and
# new files, generated files excluded.
#
# Allowed phrases: "customer ENI" and "customer-owned" are AWS terms for
# network interfaces and names in the account that uses a service.
set -euo pipefail

cd "$(dirname "$0")/.."

banned='\bsaas\b|application provider|end[- ]users?\b|\bcustomers?\b|\bpg\b|\bisengard\b|\b[0-9]{12}\b'
allowed='customer ENI|customer-owned'

files=$(git ls-files --cached --others --exclude-standard -- . \
  ':!:package-lock.json' ':!:package.json' ':!:.projen/**' ':!:node_modules/**' ':!:lib/**' ':!:cdk.out/**' \
  ':!:scripts/check-terms.sh')

hits=$(printf '%s\n' "$files" | xargs -r grep -n -i -E "$banned" -- 2>/dev/null | grep -v -i -E "$allowed" || true)
if [[ -n "$hits" ]]; then
  echo "check-terms: banned terms, account ids or aliases found:"
  echo "$hits"
  exit 1
fi
echo "check-terms: ok"
