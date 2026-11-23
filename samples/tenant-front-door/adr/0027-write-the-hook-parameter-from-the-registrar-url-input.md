<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0027: Write the hook parameter from a registrar URL input

- Status: Accepted
- Date: 2026-11-20
- Amends: ADR-0014
- Deciders: Dave Roberts (PSA)

## Context

The route hook runs in the control plane's account (ADR-0017) and finds
a front door through the front door hook parameter,
`/application-plane/applications/<applicationId>/shared/front-door-hook`,
which the `RouteHookAccess` stack writes in that account (spec §3.1). The
hook needs the registrar's URL, and in `host` mode `appDomain` and
`addressing` too, to poll the tenant's host after a write (spec §4.2).
The `RouteHookAccess` policy also names the registrar's API id and stage
in its `execute-api:Invoke` resources. The registrar is a REST API in
the edge account, so its URL exists only once the main stack is
deployed, and CDK cannot pass a value from a stack in one account to a
stack in another. When the control plane and the edge share an account
the value could cross, but a deployment's edge account is the vendor's
own and usually not the control plane's (spec §6.1).

## Options considered

### Option 1: A `registrarUrl` input, read after the main stack is deployed

The deployer deploys the front door, reads `registrarUrl` from the edge
parameter, and runs the same app again with `--context registrarUrl=...`,
which adds `<prefix>-route-hook-access` in the control plane's account
and Region. The stack writes one JSON document, `{version, registrarUrl,
appDomain, addressing}`. Pros: one app and one set of inputs; synth
checks the URL's form, Region and stage, so the policy names exactly this
registrar; no role in one account reads the other. Cons: two deploy
steps, and a redeploy that replaces the registrar's API (a new API id)
needs the stack deployed again with the new URL. Until then the old
API's host does not resolve, so the hook gets no answer, retries for
about two minutes and fails that application's operations.

### Option 2: The hook reads the edge parameter across accounts

`RouteHookAccess` writes only a pointer, and the hook assumes a role in
the edge account to read `/application-plane/shared/front-door/edge`.
Pros: the URL is never copied, so it cannot go stale. Cons: a role in the
edge account that the shared `<fleet>-global-hook` can assume, which
every global hook could then use (ADR-0017's residual, widened to the
edge account's SSM); one more call on every hook run; and the hook
policy still cannot name the API id at synth.

### Option 3: A fixed registrar domain

Give the registrar a custom domain derived from `appDomain`, so the URL
is known before any deploy. Pros: one deploy step. Cons: a regional ACM
certificate and a DNS record in the edge account for an API no browser
calls, and the policy still names the API id, which only a deploy gives.

### Option 4: A separate app for `RouteHookAccess`

Pros: the control plane's account gets its own deploy. Cons: a second
app with its own copy of `applicationId`, `appDomain`, `addressing` and
the account ids, which can disagree with the front door's.

## Decision

Option 1. The front door's inputs already hold every value but the URL,
and an input checked at synth keeps the policy scoped to one API id and
stage. The parameter is one JSON document with a `version`, so the hook
gets `appDomain` and `addressing` from the same read and refuses a
document it does not know. A stale URL fails loudly: the old API's host
does not resolve, so the hook gets no answer, retries for about two
minutes (spec §5.2) and then fails the operation. Only the application
whose parameter is stale is affected, because the hook reads only that
application's parameter (T-58).

## Consequences

- Setup in the control plane's account is a second run of the front door
  app with `registrarUrl`, deployed with that account's credentials, then
  the `globalHookManagedPolicyArns` update and `register-hooks.sh`
  (spec §6.1, §10 step 1).
- A main stack update that replaces the registrar's REST API needs the
  `RouteHookAccess` stack deployed again with the new URL before the next
  create or update of the application.
- The build's synth uses a placeholder `registrarUrl`, so cdk-nag checks
  the stack on every build.
- The hook parameter's value changes from a URL to a JSON document (spec
  §6.4); ADR-0014's 2026-11-20 note records that change.
- Revisit if CDK gains cross-account references, or if the registrar
  gets a stable domain for another reason.
