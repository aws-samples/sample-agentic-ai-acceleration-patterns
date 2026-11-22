<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0019: Give the stress cell a cell API origin, and read its ingress with a reader role

- Status: Accepted
- Date: 2026-11-21
- Deciders: Dave Roberts (PSA)

## Context
"Spec" below means
[`docs/stress-test.spec.md`](../../docs/stress-test.spec.md).

Two facts of the front door fix what a stress cell must hold (front-door spec
§3.2, §3.4, §6.3). The route hook writes a cell's route from the cell script's
`frontDoorApiDomain` output, and a cell with no route fails every deployment's
hook with 409. And the front door's `agentIngress` is the ingress's own URL,
which the ingress publishes in the cell account. The control plane does not
return script outputs (control-plane R-43), so the platform account has to
read that parameter from the cell account, and a cell account holds nothing
the platform account may read (spec §3.7).

## Options considered
### Option 1: Deploy the front door's `DemoCellApi` in the stress cell
The cell app adds the sample's own cell API origin construct (function with an
`AWS_IAM` function URL, `CellRouteAccess` for the distribution), takes its
issuer from the stress identity in the cell account, and writes the
function URL host as `frontDoorApiDomain`. Pros: the platform run drives the
cell API the front door was designed against, including its token check and
its hosts check, so the `/api/*` assertions of spec §5.3 are real. Cons: the
cell build bundles a Lambda function, which needs the front door's source in
the script zip and a `node_modules` link in the build; the bundled `jose` is
the runtime-isolation sample's version.

### Option 2: A minimal origin written for the stress test
Pros: nothing to link. Cons: a second implementation of the cell API's checks
that no sample tests, so the stress test would check its own stand-in.

### Option 3: Read the ingress parameter with the cell role pair
The control plane's role pair reads parameters under its namespaces. Pros: no
new role. Cons: the role pair is the control plane's, and the platform
account would have to ask a build to read a value and hand it back, or hold
the build role.

### Option 4: A reader role in the cell account's account base
A role on `/` that trusts the platform account root and allows
`ssm:GetParameter` on `parameter/application-plane/shared/agent-runtime/StressCell-*/ingress` only. Pros:
the platform account reads one parameter and nothing else; the owner deploys
it with the rest of the base; it carries no boundary because it is no cell
role. Cons: one role per Region and account; the platform account root is the
trust (the platform account's own policy decides who assumes it).

## Decision
Option 1 for the origin and option 4 for the read. The cell keeps
`publishParameters=false`, so the ingress publishes under its stack's own
prefix, `/application-plane/shared/agent-runtime/StressCell-<cell id>/ingress`,
and two cells in one account never write one name. The cell script publishes
`/application-plane/cells/<cell id>/api-domain` for the control-plane driver,
which records it with the cell, the account and the reader role in the
manifest.

## Consequences
Easier: phase two of the front door reads one parameter with a role that can do
nothing else; the cell API's own log and counters are in the run.

Harder: a cell build is longer by the Lambda bundle and the DynamoDB table of
the origin's rate limit. The reader role has to be in the accounts file, one
entry per account and Region. The bundled `jose` is version 5, so an
unreachable identity issuer answers 403 where the front door's tests expect
503; the reachable-issuer path is the same.

Revisit if the cell policies grow a Region wildcard (one role for all Regions
of an account), or if the control plane returns script outputs.

The first platform run at `small` (W-9, `stress/results/2026-11-21-small.md`)
served every PS-1 tenant's `/api/whoami` from this origin, and front-door phase
two read the ingress through the reader role.
