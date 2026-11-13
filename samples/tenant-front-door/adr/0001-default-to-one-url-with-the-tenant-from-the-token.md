<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0001: Default to one URL with the tenant from the token

- Status: Proposed (spike S-7)
- Date: 2026-11-13
- Deciders: Dave Roberts (PSA)

## Context

One SPA build serves every tenant, and each `/api/*` and `/agents/*`
request must reach the cell that hosts its tenant. The tenant router runs
before any origin, so it has to find the tenant from the request itself.
Whatever names the tenant decides who can steer a request: a value the
client sets freely is a value an attacker sets freely (P-2). The choice also
fixes how many browser origins exist, how many callback URLs the issuer
must accept (§3.5), and how much onboarding work a pooled tenant costs
(P-9).

## Options considered

### Option 1: Token claim (`single` mode)

The router base64url-decodes the bearer token's payload and reads
`tenant_id` (§3.3 step 5). A token with a `tenants` list and no single
`tenant_id` gets 401 at the edge; the SPA narrows it to one tenant first
(`ARCHITECTURE.md` §2.1).

Pros: one URL, one certificate, one callback URL. Onboarding is one
registrar call and touches no DNS (P-9). The tenant comes from the same
token the origin verifies, so the route hint and the verified claim agree
by construction (P-4). Cons: every tenant shares one browser origin, so the
SPA must keep no tenant data in persistent storage (§7.2). The edge cannot
tell the tenant of a request with no token, so a per-tenant rate limit
moves to the origin (ADR-0009). Signed-out pages carry no tenant
branding.

### Option 2: Host name (`host` mode)

Each tenant gets `<tenant>.<appDomain>`; the router looks up
`host#<host>` (§3.3 step 2).

Pros: the browser separates storage and service workers per tenant (§7.3).
The tenant is known before sign-in, so `/config.json` can name it and AWS
WAF can rate-limit per host. Cons: a wildcard certificate and DNS record,
reserved labels (§4.1), one issuer callback URL per tenant (spike S-4),
and `same-site` neighbours that need `__Host-` cookies and a Public Suffix
List entry to keep apart (§7.3).

### Option 3: Client header

The client names the tenant in a header such as `X-Tenant-Id`.

Pros: simplest router. Cons: the client chooses the tenant, which P-2
rules out. The router would route on a value nothing binds to the user.

### Option 4: Path prefix

`https://<appDomain>/<tenant>/...` names the tenant.

Pros: one host, readable URLs. Cons: the path is client input, so P-2
rules it out as the source of truth. Every SPA route and asset path carries
the prefix, and the shared one-year `/assets/*` cache splits or needs
rewrites.

## Decision

Option 1 is the default, with Option 2 offered as `addressing: host`. The
token claim keeps the tenant out of client hands (P-2), costs one call to
onboard (P-9), and needs one callback URL. `host` mode stays available for
vendors that need browser separation or edge rate limits per tenant. Both
modes send the same `x-tenant-route` hint and the origin checks it the
same way (P-4, ADR-0005). Options 3 and 4 fail P-2.

## Consequences

- Easier: one certificate, one DNS record, one callback URL; the integration
  test covers the default with `test/integ.single.ts`.
- Easier: onboarding and removal touch only the route table (ADR-0003).
- Harder: the SPA must clear in-memory state on tenant switch and sign-out
  and store nothing per tenant (§7.2).
- Harder: the per-tenant rate limit runs at the origin in `single` mode
  (ADR-0009).
- Harder: the router must decode a token within CloudFront Functions
  limits (S-7, ADR-0005).
- Proposed until S-7 passes: the default rests on that decode. If S-7
  fails, `host` becomes the default addressing mode and a new record
  supersedes this one (ADR-0005).
- Follow-up: `host` mode needs spike S-4 (callback URLs) and S-6 (WAF rate
  key) before it ships, and its own integration test, `test/integ.host.ts`.
- Revisit when tenants need per-tenant browser isolation by default, or
  when the issuer cannot put one tenant claim in each token.
