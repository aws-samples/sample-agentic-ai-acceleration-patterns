<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0030: Compose roles from the backends' statements, and keep the registry actions minimal

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

Spec §3.6 lists five roles with what each may and may not do. Three
backends need different actions (ADR-0025 gave `BackendConstruct` four
statement lists), and the core must not write a backend action itself. The
spec says the tool tenant role reaches "registry items" and the reaper role
"reads, updates and deletes every registry row" without naming the
DynamoDB actions.

## Options considered

### Option 1: The core owns the registry and bucket statements, each role gets exactly the backend list made for it
Pros: one place per role; a test can assert where every statement landed;
the registry actions are decided once. Cons: a handler that needs another
registry action asks the core owner.

### Option 2: Each backend writes its registry statements
Pros: none. Cons: three copies of the tenant condition, and a mistake in
one backend widens every tenant's reach.

## Decision

Option 1.

| Role | Core statements | Backend list |
|---|---|---|
| Tool role | `sts:AssumeRole` and `sts:TagSession` on the tool tenant role | `toolStatements()` |
| Tool tenant role | `s3:GetObject` on `inputs/${aws:PrincipalTag/TenantId}/*`, `s3:PutObject` on `outputs/${aws:PrincipalTag/TenantId}/*`, `dynamodb:GetItem`, `PutItem`, `UpdateItem` on the table with `ForAllValues:StringEquals` `dynamodb:LeadingKeys` = `TENANT#${aws:PrincipalTag/TenantId}` | `tenantStatements()` |
| Reaper role (reaper and offboard) | `dynamodb:GetItem`, `Query`, `Scan`, `UpdateItem`, `DeleteItem` on the table | `reaperStatements()` |
| Drain role | the reaper role's | `reaperStatements()` and `drainStatements()` |

- The tenant role trusts the tool roles by ARN, with `sts:TagSession`, and
  only when the request carries a `TenantId` tag (`Null`
  `aws:RequestTag/TenantId` false).
- The tool tenant role has no `DeleteItem` and no `Query`: the tool reads
  one row by key, takes it over with a put, and updates it (spec §4.1).
  The reaper and offboard functions delete and list.
- No role but the tenant role reads the bucket. The tool role holds no
  `s3:` and no `dynamodb:` action.
- The reaper role never holds an instance action (`ecs:Deregister...`,
  `ec2:DescribeInstances`); those arrive only through `drainStatements()`.
  Offboard runs as the reaper role.

- cdk-nag's IAM5 findings on the roles are acknowledged from one table in
  `src/core/nag.ts` (`KNOWN_WILDCARDS`), each entry naming the resource shape
  (a cluster's task or container instance id, a runtime endpoint, a log group
  name or prefix, a network interface, the tenant's own prefix, or a resource
  the action cannot name), the actions it may carry, and the reason. A
  wildcard with a wider action, or a shape not in the table, stays a finding.
  The same module acknowledges the ECS-required managed policy, the cluster
  insights rule (ADR-0013) and the image copy library's role (ADR-0029).

## Consequences

The policy cannot check the tenant id's characters: a session tag value may
contain `/`, and `inputs/a/*` also covers a tenant named `a/b`. The tool
handlers must refuse a tenant id that holds `/` or `*` (the signed tenant
context and the vendor's identity provider already use a restricted
alphabet). A handler that needs `Query` on the tenant role (for example to read a
tenant's rows in one call) needs a change here and an ADR amendment. The
synth tests assert each `fake:` marker statement lands on one role only,
and that the reaper role holds none of the drain list.
