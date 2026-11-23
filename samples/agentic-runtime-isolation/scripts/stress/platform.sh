# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# What slice.sh needs in platform mode (STRESS_MODE=platform; docs/stress-test.spec.md §3.3,
# §3.4, §4.2; stress/README.md, "Platform mode: manifests"; ADR-0054). Sourced, not run.
#
# In platform mode the slice deploys no cell and seeds nothing. The control plane builds the
# cells, tenant-identity holds the users, and the front door is the edge, so the slice reads
# the manifests those slices wrote to $STRESS_HOME/$STRESS_PREFIX and drives the edge. Needs
# jq, STRESS_HOME, STRESS_PREFIX, STRESS_TIER and STRESS_STATE_DIR (slice.sh sets the last).

PLATFORM_MANIFEST_DIR="${STRESS_HOME:-}/${STRESS_PREFIX:-}"
PLATFORM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# platform_producer FILE -> the slice that writes that manifest.
platform_producer() {
  case "$1" in
    tenant-front-door.json) echo tenant-front-door ;;
    identity.json) echo tenant-identity ;;
    control-plane.json) echo control-plane ;;
  esac
}

# need_platform_inputs VERB -> exits 1 naming every manifest that is missing or unusable.
# Sets EDGE_URL (an https origin, no path), IDENTITY_API (with a trailing slash), IDENTITY_CLIENT,
# and IDENTITY_REGION.
need_platform_inputs() {
  local verb="$1" f bad=0 d="$PLATFORM_MANIFEST_DIR"
  for f in tenant-front-door.json identity.json control-plane.json; do
    if [[ ! -s "${d}/${f}" ]]; then
      echo "slice.sh ${verb}: platform mode reads ${d}/${f}, which the $(platform_producer "$f") slice writes; it is missing" >&2
      bad=1
    elif ! jq -e 'type == "object"' "${d}/${f}" >/dev/null 2>&1; then
      echo "slice.sh ${verb}: ${d}/${f} (written by the $(platform_producer "$f") slice) is not a JSON object" >&2
      bad=1
    fi
  done
  (( bad == 0 )) || exit 1

  EDGE_URL="$(jq -r '.edgeUrl // empty' "${d}/tenant-front-door.json")"
  EDGE_URL="${EDGE_URL%/}"
  [[ "$EDGE_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] \
    || { echo "slice.sh ${verb}: tenant-front-door.json (written by the tenant-front-door slice): edgeUrl must be an https origin with no path (got '${EDGE_URL:-nothing}')" >&2; exit 1; }

  EDGE_BACKEND="$(jq -r '.agentBackend // "default"' "${d}/tenant-front-door.json")"
  [[ "$EDGE_BACKEND" =~ ^[a-z0-9-]{1,32}$ ]] \
    || { echo "slice.sh ${verb}: tenant-front-door.json (written by the tenant-front-door slice): agentBackend must match [a-z0-9-]{1,32}" >&2; exit 1; }

  IDENTITY_API="$(jq -r '.apiUrl // empty' "${d}/identity.json")"
  IDENTITY_CLIENT="$(jq -r '.appClientId // empty' "${d}/identity.json")"
  IDENTITY_REGION="$(jq -r '.region // empty' "${d}/identity.json")"
  [[ "$IDENTITY_API" =~ ^https://[a-z0-9]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com(/[A-Za-z0-9_./-]*)?$ ]] \
    || { echo "slice.sh ${verb}: identity.json (written by the tenant-identity slice): apiUrl must be an execute-api URL (got '${IDENTITY_API:-nothing}')" >&2; exit 1; }
  [[ "$IDENTITY_API" == */ ]] || IDENTITY_API="${IDENTITY_API}/"
  [[ "$IDENTITY_CLIENT" =~ ^[A-Za-z0-9]{1,128}$ ]] || { echo "slice.sh ${verb}: identity.json (written by the tenant-identity slice): appClientId is missing or malformed" >&2; exit 1; }
  [[ "$IDENTITY_REGION" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || { echo "slice.sh ${verb}: identity.json (written by the tenant-identity slice): region is missing or malformed" >&2; exit 1; }
  # k6 signs IssueToken for AWS_REGION, so an identity in another Region would answer 403.
  [[ -z "${AWS_REGION:-}" || "$IDENTITY_REGION" == "$AWS_REGION" ]] \
    || { echo "slice.sh ${verb}: identity.json (written by the tenant-identity slice): region ${IDENTITY_REGION} is not this run's Region ${AWS_REGION}" >&2; exit 1; }

  jq -e '.seeded | type == "array"' "${d}/control-plane.json" >/dev/null 2>&1 \
    || { echo "slice.sh ${verb}: ${d}/control-plane.json (written by the control-plane slice): \"seeded\" must be an array" >&2; exit 1; }
  # identity[] is the control-plane driver's record of the identity tenants it made (stress ADR-0017); absent until PS-1 has run.
  jq -e '(.identity // []) | type == "array"' "${d}/control-plane.json" >/dev/null 2>&1 \
    || { echo "slice.sh ${verb}: ${d}/control-plane.json (written by the control-plane slice): \"identity\" must be an array" >&2; exit 1; }
}

# build_platform_manifest TIER_JSON FILE -> writes the manifest of the tenants this run drives
# to FILE (the shape k6's loadManifest reads) and the refusals to
# $STRESS_STATE_DIR/platform-tenants.json, prints each refusal by tenant and reason, and exits
# 1 when fewer than two tenants are usable (the read-other probe needs two).
build_platform_manifest() {
  local tier="$1" out="$2" active built usable total d="$PLATFORM_MANIFEST_DIR"
  active="$(jq -er .tenantsActive <<<"$tier")" || { echo "slice.sh run: the tier has no tenantsActive" >&2; exit 1; }
  built="$(jq -n --slurpfile cp "${d}/control-plane.json" \
    --argjson active "$active" --arg scale "${STRESS_TIER:-}" -f "${PLATFORM_DIR}/platform-tenants.jq")" \
    || { echo "slice.sh run: could not read ${d}/control-plane.json" >&2; exit 1; }
  mkdir -p -m 700 "$STRESS_STATE_DIR" "$(dirname "$out")"
  ( umask 077; jq .manifest <<<"$built" >"$out" )
  ( umask 077; jq '{refused, ignored}' <<<"$built" >"${STRESS_STATE_DIR}/platform-tenants.json" )
  usable="$(jq '.manifest.tenants | length' <<<"$built")"
  total="$(jq '(.manifest.tenants | length) + (.refused | length)' <<<"$built")"
  echo "platform tenants: ${usable} of ${total} steady tenants usable, $(jq '.ignored | length' <<<"$built") identity tenants outside the control plane ignored"
  jq -r '.refused[] | "  refused \(.tenantId): \(.reason)"' <<<"$built"
  if (( usable < 2 )); then
    echo "slice.sh run: platform mode needs at least two usable tenants, ${usable} found: onboard the control plane's tenants (PS-1) and give them identity tenants and users (the control-plane slice's identity[]) first" >&2
    exit 1
  fi
}
