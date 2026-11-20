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

### Option 3: Create the bound function's log group inside `bindRunCode` and put it behind the log drain
Pros: uniform. Cons: the group is named after the function, so the group
depends on the function, the function depends on the drain (it must be
deleted first so no new sandbox starts), and the drain depends on the log
drain, which depends on the group: a cycle.

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
- `bindRunCode(fn)` takes a `lambda.Function` and sets its VPC config,
  timeout and environment on the underlying `CfnFunction`, adds the tool
  statements to its role, adds the role to the tenant role's trust, and
  adds only the function resource (not its role) to the drain's dependents.
  If the function was built with its own log group the core reads it; if
  not it creates `/aws/lambda/<function name>` (retention one month, deleted
  on destroy), outside the log drain (Option 3's cycle).
- `reaper` and `offboard` share one role; the drain has its own.

## Consequences

A handler author writes `Delete` so that every path ends in a response. A
gateway function built without its own log group loses a final log line if
it runs in the seconds around its stack's delete; one built with a log group
the app owns is the app's to protect. Revisit if a function can take its
log group after construction.
