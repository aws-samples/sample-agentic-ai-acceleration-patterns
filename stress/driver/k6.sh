#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Runs one k6 script on the stress driver host and brings back its result records
# (stress ADR-0008). A slice's `run` verb calls this.
#
#   AWS_REGION=eu-central-1 STRESS_PREFIX=<prefix> STRESS_RESULTS=<local folder> \
#     [K6_COMMAND=run|inspect] [K6_INPUTS="<local file> ..."] [K6_TIMEOUT=3600] \
#     stress/driver/k6.sh <script, repository-relative> [NAME=value ...]
#
# What the host gets:
# - a mirror of the repository's `stress/k6/` and of the script's own folder under
#   /opt/stress/repo/, at the same relative paths, so the script's imports of
#   `../../../../../stress/k6/lib.js` resolve as they do in a checkout;
# - each K6_INPUTS file in /opt/stress/inputs/ (a seed manifest);
# - STRESS_RUN_ID, STRESS_TIER_JSON, STRESS_MODE, STRESS_COMMIT and STRESS_TIER from this
#   shell when set, STRESS_RESULTS=/opt/stress/out/results, and every NAME=value argument;
# - the instance role's credentials, resolved on the host (the k6 AWS library does not read
#   the instance metadata service), so IssueToken calls can be signed.
# The host runs `k6 <K6_COMMAND> <script>` in the script's folder. Its stdout and stderr, and
# the files k6 wrote to STRESS_RESULTS, come back: the records to $STRESS_RESULTS, and into
# <parent of STRESS_RESULTS>/k6/ the text as <script>.k6-stdout.txt and k6's summary (SUMMARY_PATH,
# `summary.json` by default, for a slice's `collect`) as <script>.summary.json, so a second
# scenario does not overwrite the first. The exit code is k6's. Nothing here prints a token, and
# k6 must not be run with --http-debug.
#
# The mirror travels inside the Run Command parameters (about 100 KB at most), compressed:
# this is for the shared library and one sample's scenario folder, not for data.

set -euo pipefail

: "${AWS_REGION:?Set AWS_REGION to the Region the driver stack is in}"
: "${STRESS_PREFIX:?Set STRESS_PREFIX to the prefix the driver was deployed with}"
: "${STRESS_RESULTS:?Set STRESS_RESULTS to the local folder for the result records}"
export AWS_DEFAULT_REGION="$AWS_REGION"
for tool in aws jq tar gzip base64; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done
[[ $# -ge 1 ]] || { echo "usage: stress/driver/k6.sh <script> [NAME=value ...]" >&2; exit 2; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"
SCRIPT="${1#"${REPO}/"}"
shift
[[ "$SCRIPT" != /* && "$SCRIPT" != *..* && -f "${REPO}/${SCRIPT}" ]] || { echo "the script must be a file in the repository, given relative to its root: ${SCRIPT}" >&2; exit 2; }
SCRIPT_DIR="$(dirname "$SCRIPT")"
COMMAND="${K6_COMMAND:-run}"
[[ "$COMMAND" =~ ^(run|inspect)$ ]] || { echo "K6_COMMAND must be run or inspect" >&2; exit 2; }
[[ "$STRESS_PREFIX" =~ ^[A-Za-z][A-Za-z0-9]{0,39}$ ]] || { echo "STRESS_PREFIX must be 1 to 40 letters and digits, starting with a letter" >&2; exit 2; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# sq VALUE -> VALUE in single quotes for the host's shell (POSIX; AWS-RunShellScript runs sh).
sq() { printf "'%s'" "${1//\'/\'\\\'\'}"; }

tar czf "${TMP}/mirror.tgz" -C "$REPO" --exclude=node_modules stress/k6 "$SCRIPT_DIR"
INPUTS=()
for f in ${K6_INPUTS:-}; do
  [[ -f "$f" ]] || { echo "K6_INPUTS: no file ${f}" >&2; exit 2; }
  INPUTS+=("$f")
done
if (( ${#INPUTS[@]} > 0 )); then
  mkdir "${TMP}/inputs"
  cp "${INPUTS[@]}" "${TMP}/inputs/"
  tar czf "${TMP}/inputs.tgz" -C "$TMP" inputs
fi

{
  echo 'set -eu'
  echo 'rm -rf /opt/stress/repo /opt/stress/inputs /opt/stress/out'
  echo 'mkdir -p /opt/stress/repo /opt/stress/out/results'
  echo "echo $(base64 -w0 <"${TMP}/mirror.tgz") | base64 -d | tar xz -C /opt/stress/repo"
  if [[ -f "${TMP}/inputs.tgz" ]]; then
    echo "echo $(base64 -w0 <"${TMP}/inputs.tgz") | base64 -d | tar xz -C /opt/stress"
  fi
  NAMES=""
  for name in STRESS_RUN_ID STRESS_TIER_JSON STRESS_MODE STRESS_COMMIT STRESS_TIER; do
    [[ -z "${!name:-}" ]] || { echo "export ${name}=$(sq "${!name}")"; NAMES="${NAMES} ${name}"; }
  done
  echo 'export SUMMARY_PATH=/opt/stress/out/summary.json'
  for kv in "$@"; do
    [[ "$kv" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || { echo "not NAME=value: ${kv%%=*}" >&2; exit 2; }
    echo "export ${kv%%=*}=$(sq "${kv#*=}")"
    NAMES="${NAMES} ${kv%%=*}"
  done
  echo "export STRESS_RESULTS=/opt/stress/out/results"
  echo "export AWS_REGION=$(sq "$AWS_REGION")"
  echo 'eval "$(aws configure export-credentials --format env)"'
  echo "cd $(sq "/opt/stress/repo/${SCRIPT_DIR}")"
  echo 'rc=0'
  # `k6 inspect` does not read the process environment, so it gets each variable as --env.
  echo "set -- ${COMMAND}"
  if [[ "$COMMAND" == inspect ]]; then
    echo "for n in ${NAMES} STRESS_RESULTS; do eval \"v=\\\${\$n}\"; set -- \"\$@\" --env \"\$n=\$v\"; done"
  fi
  echo "k6 \"\$@\" $(sq "$(basename "$SCRIPT")") >/opt/stress/out/k6-stdout.txt 2>&1 || rc=\$?"
  echo 'tar czf /opt/stress/out.tgz -C /opt/stress out'
  echo 'echo "k6 exit=${rc}"'
  echo '[ "$rc" -eq 0 ] || tail -n 40 /opt/stress/out/k6-stdout.txt'
  echo 'echo "OUT_BASE64_BEGIN"'
  echo 'base64 -w0 /opt/stress/out.tgz'
  echo 'echo'
  echo 'echo "OUT_BASE64_END"'
  echo 'exit "$rc"'
} >"${TMP}/remote.sh"
(( $(wc -c <"${TMP}/remote.sh") < 90000 )) || { echo "the mirror is too large for Run Command parameters" >&2; exit 2; }

set +e
HOST_TIMEOUT="${K6_TIMEOUT:-3600}" "${HERE}/host.sh" "$(cat "${TMP}/remote.sh")" >"${TMP}/host.out"
code=$?
set -e

# The output holds the text before the markers, then the base64 tarball of /opt/stress/out.
sed -n '1,/^OUT_BASE64_BEGIN$/{/^OUT_BASE64_BEGIN$/!p}' "${TMP}/host.out"
mkdir -p "$STRESS_RESULTS"
if sed -n '/^OUT_BASE64_BEGIN$/,/^OUT_BASE64_END$/{/^OUT_BASE64_/!p}' "${TMP}/host.out" | base64 -d >"${TMP}/out.tgz" 2>/dev/null && [[ -s "${TMP}/out.tgz" ]]; then
  tar xzf "${TMP}/out.tgz" -C "$TMP"
  cp -R "${TMP}/out/results/." "$STRESS_RESULTS/"
  DEST="$(dirname "${STRESS_RESULTS%/}")/k6"
  NAME="$(basename "$SCRIPT" .js)"
  mkdir -p "$DEST"
  cp "${TMP}/out/k6-stdout.txt" "${DEST}/${NAME}.k6-stdout.txt" || echo "could not keep k6's stdout" >&2
  if [[ -f "${TMP}/out/summary.json" ]]; then
    cp "${TMP}/out/summary.json" "${DEST}/${NAME}.summary.json" || echo "could not keep k6's summary" >&2
  fi
else
  echo "no output archive came back from the host" >&2
fi
exit "$code"
