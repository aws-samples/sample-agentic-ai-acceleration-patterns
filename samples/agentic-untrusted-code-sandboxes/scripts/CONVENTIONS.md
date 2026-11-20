<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Conventions

Rules for the scripts in this directory and for contributors who build
this sample in parallel.

## Who may change what

| Path | May change it | Rule |
|---|---|---|
| `.projenrc.ts`, `package.json`, `package-lock.json`, `.projen/` | the maintainers only | Every dependency the sample needs is already there (ADR-0023). A missing one is a question for the maintainers, never a local edit: the lock file does not merge |
| `runner/PROTOCOL.md`, `runner/protocol/`, `src/protocol.ts` | a maintainer decision | Both sides of the protocol and the vectors change in one pull request (ADR-0025) |
| `src/backend.ts`, `src/backend-construct.ts` | a maintainer decision | The interface every backend and the core build against |
| `src/backends/<name>.ts`, `src/backends/<name>.cdk.ts` | that backend's owner only | Implement the interface; read settings from the environment your `BackendConstruct` sets |
| `runner/` (except the protocol files) | the runner owner | Standard library only; the Dockerfile base images stay pinned by digest (ADR-0024) |
| `src/untrusted-code-sandboxes.cdk.ts`, `src/props.ts`, `src/tool/`, `src/reaper/`, `src/drain/`, `src/offboard/` | the core owner | `HANDLERS` in `src/handler-entry.ts` names every Lambda entry |
| `src/gateway/` | the gateway owner | The only part of `src/` (with `src/main.ts` and `src/demo.cdk.ts`) that may import `agentic-runtime-isolation` |
| `design/`, accepted ADRs | nobody in a build branch | A spec gap gets a new ADR in your reserved number range, not an edit |
| `adr/README.md` | anyone adding an ADR | One row per new ADR, in number order |

## Build

- `npx projen build` is the gate: compile, the handler copy, synth with
  cdk-nag, jest, eslint, the Python tests (`test:runner`), the header check
  (`check:headers`) and the terms check (`check:terms`) (ADR-0026).

## Script rules

- `set -euo pipefail`; never `set -x`. A `: "${VAR:?...}"` guard for each
  required input (`AWS_REGION` and the tools the script needs).
- Never print a credential, token, nonce, `jobAuth`, proof, auth token,
  header value, code, input or output. Log the step, the tenant id, the
  HTTP status, sizes and the outcome code.
- AWS CLI output counts as output: filter it with `--query` into a
  variable, or send it to `/dev/null` when only the exit status matters.
- Temp files come from `mktemp` and are removed by an `EXIT` trap.
- Every authored file carries the MIT-0 header. Invented tenants only
  (`tenant-a`, `tenant-b`); no account id or account alias anywhere.
- A script that deploys also destroys what it created from its `EXIT`
  trap, and prints the leftovers it could not remove.
