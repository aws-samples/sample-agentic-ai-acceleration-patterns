<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0029: Wire the functions, the drain and the log groups from one construct

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

Spec §3.1, §3.3 and §5.3 want four functions (tool, reaper, drain,
offboard) in the tool subnets, a function bound with `bindRunCode` to get
everything the core function has, a drain that runs on delete before the
backends' resources go, and log groups that are deleted with the stack
without a late write recreating them. The handlers are written by another
owner; this decision fixes the contract between the two.

## Options considered

### Option 1: Direct custom resource for the drain; `NodejsFunction` per handler; log drain for the construct's own groups
Pros: the drain handler answers the CloudFormation response URL itself,
as the siblings' custom resources do, and needs no framework Lambda in the
VPC; the log drain is the proven wait-between-writers-and-groups pattern.
Cons: the handler must always answer (a `try`/`finally`), or the delete
waits `ServiceTimeout`.

### Option 2: `custom-resources.Provider`
Pros: the handler returns a value or throws. Cons: two framework Lambdas
per provider, one more role, and the drain's 10-minute wait runs inside the
framework's own timeout.

### Option 3: Name a bound function's log group `/aws/lambda/<function name>`
Pros: no change to the function. Cons: the group depends on the function, the
function depends on the drain (it must be deleted first so no new sandbox
starts) and on the log drain, and the log drain depends on the group: a
cycle. Left outside the log drain instead, the group is deleted before the
function and a late invocation recreates it with no retention.

## Decision

Option 1.

- The drain is `AWS::CloudFormation::CustomResource` with `ServiceToken` =
  the drain function. `Create` and `Update` answer at once; `Delete` stops
  every sandbox and answers success or failure through `ResponseURL`, always
  (spec §5.3). The function timeout and `ServiceTimeout` are both 15 minutes.
- Delete order: tool functions, then the drain, then each backend's
  `drainOrder()` resources, then the log cleanup resource. The tool
  functions depend on the drain; the drain depends on every `drainOrder()`
  resource and on the registry table; every `drainOrder()` resource depends
  on the log cleanup resource.
- The core builds all four functions with an explicit log group each
  (retention one month, deleted on destroy), behind a log drain that waits
  90 s on delete. Function logs use the JSON format and application level
  INFO, so a line written with `process.stdout.write` keeps its top-level
  fields for Logs Insights and Contributor Insights.
- `bindRunCode(fn)` takes a `lambda.Function` built with a role created in
  the app (an imported role is refused, because its policy cannot be
  changed) and sets its VPC config, timeout and environment on the
  underlying `CfnFunction`. The tool statements and the network interface
  statement go on the function's own role, so a bound function holds the
  same rights as the tool role without running as it, and the role is added
  to the tenant role's trust. The function resource, not its role, becomes
  a dependent of the drain. If the function was built with its own log group
  the core reads it; if not the core creates an unnamed group (retention one
  month, deleted on destroy), sets it on the function, grants the role the
  write, and puts it behind the log drain like its own (the function depends
  on the group, so there is no cycle). The tenant role's trust policy has a
  default limit of 2,048 characters, about seven bound roles; share one
  role when more are needed.
- No role of the construct attaches `AWSLambdaVPCAccessExecutionRole`. Its
  document also allows log writes and `logs:CreateLogGroup` on every group,
  which would let a function recreate a group the stack deleted. The roles
  hold the six network interface actions as one inline statement, and the
  functions get an immutable reference to the role so the L2 adds no managed
  policy. A function writes only to its own group.
- The image copy library puts one Lambda in the stack, shared by every copy,
  with ECR write and S3 read on every resource and no log group of its own.
  The core adds explicit denies to its role (ECR write outside the stack's
  runner repositories, any S3 action on the stack's input buckets, log
  group creation), gives it a log group the core owns behind the log drain,
  and makes it wait for the log drain. The bucket's auto-delete provider,
  which CDK adds with no log group, has its group deleted by the log cleanup
  resource after the bucket has been emptied.
- The reaper schedule is deleted before the drain starts, so the reaper
  and the drain never sweep at once.
- Every custom resource of the construct sets `ServiceTimeout` a little above
  its function's timeout, so a function that cannot start never holds a delete
  for the default hour.
- `reaper` and `offboard` share one role; the drain has its own.
- The core copies the runner image (ADR-0024) for every container backend:
  `BackendContext.runnerImageTag(arch)` builds the image asset and the copy
  into the construct repository the first time an architecture is asked for,
  and returns `runner-<arch>-<asset hash>`. The core makes each of that
  backend's `drainOrder()` resources depend on the copies the backend asked
  for, so the runtime or cluster is never created before its image exists and
  is deleted before the copy, and the repository is emptied last. `microvm`
  asks for no tag and waits for no copy.

## Consequences

A handler author writes `Delete` so that every path ends in a response. A
gateway function built with its own log group has that group in the app's
hands; the core cannot put it behind its log drain. The function lists in
the spec say a bound function runs as the shared tool role; it holds the
same statements on its own role instead, because a function's role is fixed
when it is built. Revisit if the spec wants one role.
