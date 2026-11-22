<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0014: Run one front door per control-plane application

- Status: Accepted
- Date: 2026-11-13
- Amended by: ADR-0017
- Deciders: Dave Roberts (PSA)

## Context

The control plane registers applications, and a tenant has at most one
deployment of each. A front door serves one SPA, one issuer client and one
`appDomain`, and routes each tenant to the cell that hosts its deployment.
The registrar checks a tenant route with `GetDeployment(tenantId,
applicationId)` (§3.4), so it must know which application a route is for.
A vendor may run several applications on one control plane, each with its
own web client and cells.

## Options considered

### Option 1: One front door per application

Each front door takes one `applicationId` at deploy time (§3.6). Pros: the
route table needs no application dimension, so keys stay `tenant#<id>`
and the router reads at most three keys; the registrar uses its own
`applicationId` and never trusts one from the body; one SPA build, one
issuer client and one header baseline per application; the store ceiling
(ADR-0012) and the blast radius of a bad route table write are one
application's. Cons: one distribution, certificate, web ACL and registrar
per application; each application needs its own domain.

### Option 2: One shared front door keyed by application

One distribution for every application, with keys like
`tenant#<app>#<id>`. Pros: one edge stack for the vendor. Cons: the router
must find the application from the host or the path, a new input the
client controls; several SPAs and issuer clients behind one distribution,
with one header baseline for all; every application shares one store's
ceiling; a registrar bug reaches every application's routes.

## Decision

Option 1. A front door serves exactly one control-plane application. The
`applicationId` is a stack input, never a request or body value, so the
registrar's placement check and the router's keys stay simple, and each
application keeps its own route table, ceiling and baseline.

## Consequences

- The registrar refuses a deployment or cell that belongs to another
  application with 403 (§3.4 step 3).
- The published parameter `/application-plane/shared/front-door/edge`
  names the `applicationId`, and its copy in each cell account sits under
  `/application-plane/applications/<applicationId>/`, so cell scripts reach
  the right registrar (§6.4).
- A vendor with several applications deploys several front doors, each
  with its own domain and certificate.
- Agent traffic (`/agents/*`) follows the application: each front door
  points at the agent ingress it is configured with.
- Revisit when a vendor runs many small applications whose per-front-door
  cost outweighs the isolation, or when one web client must reach several
  applications.

Note 2026-11-18, effective when ADR-0017 (Proposed) is accepted: cell
scripts will no longer call the registrar, so the copy in each cell
account will hold only `distributionArn`, for `CellRouteAccess`. Each
front door's `RouteHookAccess` stack will write
`/application-plane/applications/<applicationId>/shared/front-door-hook`,
with `registrarUrl`, in the control plane's account, a name of its own
so that it never collides with the cell-account copy in a control-plane
account that also hosts cells. The route hook,
one pair of global hooks for every front door on the control plane,
will act only for an application that has that parameter and exits 0 for
every other, so one front door per application will still hold.

Note 2026-11-20: ADR-0017 is accepted, so the 2026-11-18 note above is in
effect. The hook parameter is one JSON document, `registrarUrl` with
`appDomain` and `addressing`, which the route hook needs to poll a
tenant host in `host` mode (ADR-0027).
