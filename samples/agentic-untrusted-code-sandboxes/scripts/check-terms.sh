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

banned='\bsaas\b|application provider|end[- ]users?\b|\bcustomers?\b|\b[0-9]{12}\b'
# Account aliases are private, so they are not written here: a contributor
# passes them as an extended regex in CHECK_TERMS_PRIVATE (for example from
# their shell profile), and the check adds them.
if [[ -n "${CHECK_TERMS_PRIVATE:-}" ]]; then
  banned="${banned}|${CHECK_TERMS_PRIVATE}"
elif [[ "${CHECK_TERMS_REQUIRE_PRIVATE:-}" == "1" ]]; then
  # A pipeline that must prove the tree holds no alias sets this, so a missing pattern fails the check.
  echo "check-terms: CHECK_TERMS_REQUIRE_PRIVATE=1 but CHECK_TERMS_PRIVATE is not set, so account aliases were not checked" >&2
  exit 2
fi
allowed='customer ENI|customer-owned'

files=$(git ls-files --cached --others --exclude-standard -- . \
  ':!:package-lock.json' ':!:package.json' ':!:.projen/**' ':!:node_modules/**' ':!:lib/**' ':!:cdk.out/**' \
  ':!:scripts/check-terms.sh' ':!:test/check-terms.test.ts')

# The allowed phrases are cut out of each matching line before it is checked again, so a banned word on the
# same line as an allowed phrase is still found.
hits=$(printf '%s\n' "$files" | xargs -r grep -n -i -E "$banned" -- 2>/dev/null | sed -E "s/${allowed}//Ig" | grep -i -E "$banned" || true)
if [[ -n "$hits" ]]; then
  echo "check-terms: banned terms, account ids or aliases found:"
  echo "$hits"
  exit 1
fi
echo "check-terms: ok"
