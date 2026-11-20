<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0055: Take the tenant from the signed context only on the gateway entry

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

Spec §3.2 says nothing downstream of the verified context accepts a tenant
id from the arguments, and §5.1 says the gateway handler refuses a
`tenantId` argument with `invalid_argument`. ADR-0017 moved the gateway
path into `RunCodeToolTarget`. Building it left four details open: what
else besides `tenantId` an argument may carry, what happens when the
verified tenant id does not fit the tenant id rule, how the target is
built from a producer construct that wants its function up front, and
which of the two names (target, tool) `toolName` sets.

## Options considered

### Option 1: Check the tenant in the handler, and refuse every argument the tool does not declare
Pros: one rule, `tenantId` is just one of the refused names, and a field
such as `tenant` or `roleArn` cannot reach code that later grows to read
it. Cons: a gateway that adds an argument of its own would be refused.
The producer's interceptor adds only `_ri_ctx`, which `toolHandler`
strips before the body runs.

### Option 2: Refuse `tenantId` only, pass the rest
Pros: smaller. Cons: the core's validator would be the only thing between
an unknown field and the code, on a path where the tenant is the whole
security property.

### Option 3: Drop the argument silently
Pros: friendlier to an agent that adds it. Cons: hides a prompt-steered
attempt to name a tenant, and the signature then covers an argument the
code ignored.

## Decision

Option 1.

- The tool body is `gatewayRunCode(runCode)`, run inside the producer's
  `toolHandler`. `toolHandler` has already verified the signature, the
  tool, the expiry and the argument hash, and stripped `_ri_ctx`. The
  target has no `tvm` role, so `toolHandler` vends nothing: the core's
  `runCode` vends the tool tenant role with the `TenantId` session tag
  itself, for the tenant id it was given, once the call is validated.
- A call whose arguments hold `tenantId` (any value, including an empty or
  non-string one), any name other than `code`, `input`, `backend` and
  `saveOutput`, or a value of the wrong type (`code`, `input` and `backend`
  are strings, `saveOutput` a boolean, so a nested object cannot carry a
  second tenant) returns `invalid_argument` with a fixed message and no
  value from the call. The core applies the §5.1 field rules to the values.
- Every refusal writes one WARN line, `tool refused`, with the reason
  (`tenant_argument`, `unknown_argument`, `argument_type`,
  `tenant_id_rule`), the tool, the transaction id and the tenant id when it
  fits the rule, as raw JSON on stdout like the producer's logger. An
  attempt to name a tenant is therefore visible in the log and never only
  in a byte count.
- The request given to `runCode` is the arguments plus `tenantId` from the
  context, set last, so no argument can override it.
- A verified tenant id that does not match `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`
  returns `context_invalid`, which refines the `invalid_argument` row of
  the §5.1 error table for this one case: the id is not the caller's to
  change, so `invalid_argument` would tell an agent to fix something it
  cannot. Nothing runs and no credential is vended.
- A fault in the gateway body becomes `tool_failed` through `toolHandler`,
  which logs the error name only; `runCode` returns `tool_failed` itself
  for its own faults. The function passes its remaining time
  to `runCode`, so a call that has used most of it starts no second sandbox.
- `RunCodeToolTarget` extends the producer's `ToolTarget`. The function is
  built first, under a holder node `<id>Handler` in the same scope as the
  target (`<id>Handler/Function`), because `ToolTarget` takes it as a prop;
  then the target is built (a Lambda target, which grants the context key's
  public half), then `sandboxes.bindRunCode` is called. The target exposes `function`,
  `name` and `tools`; the core keeps no record of it. The `toolTarget` value
  of the published sandboxes document (spec §6.3) is written by the demo
  stack from the `RunCodeToolTarget` it builds.
- `toolName` is the target name (default `run-code`); the tool inside it
  is `run_code`, so grants name `run-code/run_code`. A second target on
  the same core, such as `run-code-files`, has the same tool name under
  another target.
- The tool's input schema declares `code`, `input`, `backend` and
  `saveOutput` and uses only the keywords a Lambda target accepts (`type`,
  `properties`, `required`, `items`, `description`). The per-backend limits
  an agent writes code for are in the descriptions.

## Consequences

The order inside one call is: `toolHandler` verifies the context (an
unsigned, altered or wrongly addressed call ends here), the body checks the
argument names, their types and the tenant id rule, and only then `runCode`
validates the values and vends the tenant's credentials. No refusal costs an
STS call.

`bindRunCode` receives the function after it exists, so it sets what the
L2 function cannot change by itself through the underlying `CfnFunction`
(the VPC placement in the tool subnets, the security group, the timeout),
adds the environment, and creates the log group the core owns. The gateway
function runs as the core's tool role, so the trust and the actions that
role already holds apply to it. The gateway function itself sets what is
natural at construction: the role, the timeout (ADR-0056), the JSON log
format and bundled SDK clients.
