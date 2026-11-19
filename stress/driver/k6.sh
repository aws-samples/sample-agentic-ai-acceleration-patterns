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
#   the instance metadata service), so IssueToken calls can be signed. k6 keeps that one copy
#   for the whole run and cannot refresh it, so the host refuses to start k6 when the copy
#   expires sooner than K6_TIMEOUT plus 5 minutes (stress/k6/README.md, "Limits worth knowing").
# The host runs `k6 <K6_COMMAND> <script>` in the script's folder. Its stdout and stderr, and
# the files k6 wrote to STRESS_RESULTS, come back: the records to $STRESS_RESULTS, and into
# <parent of STRESS_RESULTS>/k6/ the text as <script>.k6-stdout.txt and k6's summary (SUMMARY_PATH,
# `summary.json` by default, for a slice's `collect`) as <script>.summary.json, so a second
# scenario does not overwrite the first. The exit code is k6's. Nothing here prints a token, and
# k6 must not be run with --http-debug.
#
# NAME=value arguments travel in the Run Command parameters, which SSM keeps in its command
# history: pass no secret that way.
#
# The mirror travels inside the Run Command parameters (below 60 KB, see the guard), compressed:
# this is for the shared library and one sample's scenario folder, not for data.
#
# A SIGINT or SIGTERM is passed on to host.sh, which cancels the command on the host.

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
TIMEOUT="${K6_TIMEOUT:-3600}"
[[ "$TIMEOUT" =~ ^[0-9]+$ ]] && (( TIMEOUT >= 10 && TIMEOUT <= 14400 )) || { echo "K6_TIMEOUT must be 10 to 14400 seconds" >&2; exit 2; }

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
  for kv in "$@"; do
    [[ "$kv" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || { echo "not NAME=value: ${kv%%=*}" >&2; exit 2; }
    echo "export ${kv%%=*}=$(sq "${kv#*=}")"
    NAMES="${NAMES} ${kv%%=*}"
  done
  echo "export STRESS_RESULTS=/opt/stress/out/results SUMMARY_PATH=/opt/stress/out/summary.json"
  echo "export AWS_REGION=$(sq "$AWS_REGION")"
  echo 'creds="$(aws configure export-credentials --format env)"'
  echo 'eval "$creds"; unset creds'
  # k6 cannot refresh this copy: refuse to start a run that would outlive it (K6_TIMEOUT + 300 s).
  echo "need=$((TIMEOUT + 300))"
  echo 'exp=0'
  echo 'if [ -n "${AWS_CREDENTIAL_EXPIRATION:-}" ]; then exp="$(date -d "$AWS_CREDENTIAL_EXPIRATION" +%s 2>/dev/null)" || { echo "the host credentials carry an expiration date it cannot read; refusing to start k6" >&2; exit 3; }; fi'
  echo 'left=$((exp - $(date +%s)))'
  echo 'if [ "$exp" -eq 0 ]; then echo "warning: the host credentials carry no expiration; k6 cannot refresh them" >&2;'
  echo 'elif [ "$left" -lt "$need" ]; then echo "the instance role credentials on the host expire in ${left} s, sooner than K6_TIMEOUT + 300 s (${need} s): k6 cannot refresh them; retry in a few minutes, when the host has fresh ones, or lower K6_TIMEOUT" >&2; exit 3; fi'
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
# The SendCommand API reference names one size limit, MaxDocumentSizeExceeded ("The size limit
# of a document is 64 KB"), and documents none for Parameters; the Systems Manager quotas page
# lists no Run Command parameter quota either (both checked 2026-11-19). The guard stays below
# 64 KB, with room for host.sh's own wrapper (under 1 KB), until a documented limit says more.
(( $(wc -c <"${TMP}/remote.sh") < 60000 )) || { echo "the mirror is too large for Run Command parameters (60 KB guard, below the 64 KB SSM document limit)" >&2; exit 2; }

# host.sh runs in the background so a SIGINT or SIGTERM here reaches it as a SIGTERM (a
# background job of a script ignores SIGINT), and it cancels the command on the host. `wait`
# returns early on a trapped signal, so wait again for host.sh to finish its cleanup.
HOST_PID=""
STOPPED=0
trap 'STOPPED=1; [[ -z "$HOST_PID" ]] || kill -s TERM "$HOST_PID" 2>/dev/null || true' INT TERM
HOST_TIMEOUT="$TIMEOUT" "${HERE}/host.sh" "$(cat "${TMP}/remote.sh")" >"${TMP}/host.out" &
HOST_PID=$!
(( STOPPED == 0 )) || kill -s TERM "$HOST_PID" 2>/dev/null || true
code=0
while :; do
  wait "$HOST_PID" && code=0 || code=$?
  kill -0 "$HOST_PID" 2>/dev/null || break
done
trap - INT TERM

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
  else
    echo "k6 wrote no summary.json" >&2
  fi
else
  echo "no output archive came back from the host" >&2
fi
exit "$code"
