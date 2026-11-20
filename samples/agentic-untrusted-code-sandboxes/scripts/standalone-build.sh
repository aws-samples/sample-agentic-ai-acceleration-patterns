#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# The `standalone-build` step of the integration test (spec §8, ADR-0017,
# ADR-0057). Proves that a vendor who imports only the core can install
# the packed sample into an app that has no `agentic-runtime-isolation`
# anywhere in its tree, compile it and synthesise it:
#
#   1. `npm pack` of the sample (a packed install carries no dev
#      dependencies and no link back to the sample);
#   2. a stub consumer app in a temporary directory, with the consumer's
#      default `cdk.json` app command (`ts-node --prefer-ts-exts`) and node10
#      module resolution, installs the tarball: no peer error, and no
#      `agentic-runtime-isolation` in `node_modules`;
#   3. `tsc` compiles the app, `cdk synth` of `UntrustedCodeSandboxes` with
#      `standalone: true` succeeds (including the handler bundles);
#   4. loading the package root puts no module of the producer in the module
#      cache, and the `gateway` subpath fails on the missing producer and on
#      nothing else.
#
# Needs the package built first (`npx projen build`, which fills lib/ and
# lib/handlers/) and the npm registry. It makes no AWS call and needs no AWS
# credentials, so it has no AWS_REGION guard. Run from anywhere:
#
#   scripts/standalone-build.sh
#
# It prints each step, the exit status of each check and, on a failure, the
# tail of the failing tool's own log (npm, tsc and cdk print no secrets).
# Everything it creates is under one temporary directory that an EXIT trap
# removes; STANDALONE_BUILD_KEEP=1 keeps it and prints its path.
set -euo pipefail

cd "$(dirname "$0")/.."

for tool in node npm npx tar; do
  command -v "$tool" >/dev/null || { echo "standalone-build: $tool is required" >&2; exit 2; }
done
: "${TMPDIR:=/tmp}"

[[ -f lib/index.js && -f lib/gateway/index.js && -d lib/handlers ]] || {
  echo "standalone-build: lib/ or lib/handlers/ is missing; run 'npx projen build' first" >&2
  exit 2
}

work="$(mktemp -d "$TMPDIR/standalone-build.XXXXXX")"
cleanup() {
  if [[ "${STANDALONE_BUILD_KEEP:-}" == "1" ]]; then
    echo "standalone-build: kept $work"
  else
    rm -r -f -- "$work"
  fi
}
trap cleanup EXIT

version() {
  node -p "const p = require('./package.json'); (p.dependencies && p.dependencies['$1']) || p.devDependencies['$1']"
}
cdk_lib="$(version aws-cdk-lib)"
constructs="$(version constructs)"
cdk_cli="$(version aws-cdk)"
ts_node="$(version ts-node)"
typescript="$(version typescript)"
types_node="$(version @types/node)"

fail() {
  local log="$1"
  echo "standalone-build: FAILED at: $step" >&2
  [[ -f "$log" ]] && tail -n 25 -- "$log" >&2
  exit 1
}

step="npm pack"
echo "standalone-build: $step"
npm pack --silent --ignore-scripts --pack-destination "$work" >"$work/pack.log" 2>&1 || fail "$work/pack.log"
tarball="$(find "$work" -maxdepth 1 -name 'agentic-untrusted-code-sandboxes-*.tgz' | head -n 1)"
[[ -n "$tarball" ]] || { echo "standalone-build: no tarball was written" >&2; exit 1; }
listing="$(tar -tzf "$tarball")"
grep -q '^package/lib/handlers/' <<<"$listing" || { echo "standalone-build: the tarball has no lib/handlers/" >&2; exit 1; }
if grep -q 'agentic-runtime-isolation' <<<"$listing"; then
  echo "standalone-build: the tarball names the producer in a path" >&2
  exit 1
fi
# Outside the gateway files, nothing the package ships may import or require the producer, in a script or
# a declaration file (a comment that names it is fine).
mkdir "$work/unpacked"
tar -xzf "$tarball" -C "$work/unpacked"
found=0
grep -r -l -E --exclude-dir=gateway "(from|require\\(|import\\()[[:space:]]*['\"]agentic-runtime-isolation" "$work/unpacked/package/lib" >"$work/producer-refs.log" || found=$?
if [[ "$found" -eq 0 ]]; then
  echo "standalone-build: these shipped files name the producer outside the gateway entry:" >&2
  sed "s|$work/unpacked/package/||" "$work/producer-refs.log" >&2
  exit 1
elif [[ "$found" -ne 1 ]]; then
  echo "standalone-build: the search of the shipped files failed (grep exit $found)" >&2
  exit 1
fi

app="$work/app"
mkdir "$app"
cat >"$app/package.json" <<'JSON'
{ "name": "standalone-consumer", "version": "0.0.0", "private": true }
JSON
cat >"$app/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["es2022"],
    "strict": true,
    "esModuleInterop": true,
    "moduleResolution": "node10",
    "skipLibCheck": false,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["app.ts"]
}
JSON
cat >"$app/cdk.json" <<'JSON'
{ "app": "npx ts-node --prefer-ts-exts app.ts" }
JSON
cat >"$app/app.ts" <<'TS'
import { App, CfnOutput, Stack } from 'aws-cdk-lib';
import { UntrustedCodeSandboxes } from 'agentic-untrusted-code-sandboxes';

const app = new App();
const stack = new Stack(app, 'Standalone');
const sandboxes = new UntrustedCodeSandboxes(stack, 'Sandboxes', { standalone: true, backends: ['microvm', 'nitro', 'agentcore'] });
// The function a vendor invokes with IAM exists only with `standalone` (spec 3.3); name it in the template.
if (sandboxes.runCodeFunction === undefined) throw new Error('standalone: true deployed no runCodeFunction');
new CfnOutput(stack, 'RunCodeFunctionArn', { value: sandboxes.runCodeFunction.functionArn });
app.synth();
TS

step="npm install of the tarball"
echo "standalone-build: $step"
(
  cd "$app"
  npm install --no-audit --no-fund "aws-cdk-lib@$cdk_lib" "constructs@$constructs" "$tarball" >"$work/install.log" 2>&1 \
    && npm install --no-audit --no-fund --save-dev "aws-cdk@$cdk_cli" "ts-node@$ts_node" "typescript@$typescript" "@types/node@$types_node" >>"$work/install.log" 2>&1
) || fail "$work/install.log"
if grep -q -i -E 'ERESOLVE|peer dep' "$work/install.log"; then
  echo "standalone-build: npm reported a peer problem" >&2
  grep -i -E 'ERESOLVE|peer dep' "$work/install.log" >&2
  exit 1
fi

step="the producer is not in the install"
echo "standalone-build: $step"
if [[ -e "$app/node_modules/agentic-runtime-isolation" ]]; then
  echo "standalone-build: agentic-runtime-isolation was installed" >&2
  exit 1
fi
if (cd "$app" && npm ls agentic-runtime-isolation >"$work/ls.log" 2>&1); then
  echo "standalone-build: npm ls finds agentic-runtime-isolation" >&2
  exit 1
fi

step="tsc"
echo "standalone-build: $step"
(cd "$app" && npx tsc -p tsconfig.json >"$work/tsc.log" 2>&1) || fail "$work/tsc.log"

step="cdk synth"
echo "standalone-build: $step"
(cd "$app" && npx cdk synth --quiet --no-version-reporting --no-notices >"$work/synth.log" 2>&1) || fail "$work/synth.log"
[[ -f "$app/cdk.out/Standalone.template.json" ]] || { echo "standalone-build: no template was written" >&2; exit 1; }
# The output names the construct's `runCodeFunction`; its resource must be a Lambda function that carries
# the registry table and the tool tenant role in its environment. The other functions of the core share
# that environment, so the output, not the environment alone, picks the right one.
node -e '
const t = require(process.argv[1]);
const out = t.Outputs && t.Outputs.RunCodeFunctionArn;
const id = out && out.Value && out.Value["Fn::GetAtt"] && out.Value["Fn::GetAtt"][0];
const r = id && t.Resources[id];
const env = r && r.Type === "AWS::Lambda::Function" && r.Properties.Environment && r.Properties.Environment.Variables;
process.exit(env && "REGISTRY_TABLE" in env && "TOOL_TENANT_ROLE_ARN" in env ? 0 : 1);
' "$app/cdk.out/Standalone.template.json" || {
  echo "standalone-build: the template's RunCodeFunctionArn is not a run_code function (the standalone entry)" >&2
  exit 1
}

step="the package root reaches no producer module"
echo "standalone-build: $step"
cat >"$app/check-root.js" <<'JS'
require('agentic-untrusted-code-sandboxes');
const reached = Object.keys(require.cache).filter((file) => file.includes('agentic-runtime-isolation'));
if (reached.length > 0) {
  console.error(`standalone-build: the package root reached ${reached.length} producer module(s)`);
  process.exit(1);
}
JS
(cd "$app" && node check-root.js) || { echo "standalone-build: FAILED at: $step" >&2; exit 1; }

step="the gateway subpath fails on the producer only"
echo "standalone-build: $step"
cat >"$app/check-gateway.js" <<'JS'
try {
  require('agentic-untrusted-code-sandboxes/gateway');
} catch (error) {
  if (error.code === 'MODULE_NOT_FOUND' && String(error.message).includes("'agentic-runtime-isolation")) process.exit(0);
  console.error(`standalone-build: the gateway subpath failed for another reason: ${error.code}`);
  process.exit(1);
}
console.error('standalone-build: the gateway subpath loaded without the producer');
process.exit(1);
JS
(cd "$app" && node check-gateway.js) || { echo "standalone-build: FAILED at: $step" >&2; exit 1; }

echo "standalone-build: ok (packed install synthesised with the producer absent)"
