<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0002: Use a CloudFront multi-tenant distribution

- Status: Accepted
- Date: 2026-11-17
- Amended by: ADR-0017
- Deciders: Dave Roberts (PSA)

## Context

The front door serves one SPA and every cell's API from one edge account
(§3.1). Pooled tenants share one domain: `<appDomain>` in `single` mode,
`*.<appDomain>` in `host` mode (ADR-0001). A tenant with its own domain
needs its own certificate, and optionally its own web ACL, without a
second copy of the behaviours, policies and origins. Onboarding a pooled
tenant must not update a distribution or invalidate a cache (P-9). Every
response must carry one security baseline that no tenant can weaken (P-8).

## Options considered

### Option 1: Multi-tenant distribution with distribution tenants

One distribution with `ConnectionMode: tenant-only` holds the shared
behaviours, response headers policy and origins. A pooled distribution
tenant serves the shared domain; a dedicated distribution tenant serves one
tenant's own domain, with its own certificate and web ACL override (§3.1).

Pros: one configuration for every tenant, so the §7 baseline is set once
(P-8). A dedicated domain is a distribution tenant, not a distribution
copy. Pooled tenants add no CloudFront resource, so onboarding stays one
registrar call (P-9). Cons: the router, the route table and origin
modification must all work on a multi-tenant distribution and on both an
apex and a wildcard distribution tenant; spike S-1 checks this. Fewer
examples exist than for standard distributions.

### Option 2: One standard distribution with a wildcard

One standard distribution with `<appDomain>` and `*.<appDomain>` as
alternate domain names.

Pros: well-known resource, every CloudFront feature available. Cons: a
tenant's own domain is another alternate domain name and a certificate
change on the shared distribution, so a dedicated tenant edits shared
configuration. Web ACL overrides per tenant are not available.

### Option 3: One distribution per tenant

Each tenant gets its own standard distribution.

Pros: full separation of configuration, certificates and web ACLs. Cons:
the baseline is copied per tenant and can drift (P-8). Onboarding creates a
distribution, which takes minutes and breaks P-9. Distributions per account
are bounded by a quota, so the tenant count is capped by it.

## Decision

Option 1; spike S-1 passed on 2026-11-16. A multi-tenant distribution keeps
one shared configuration, so the security baseline is set once (P-8), and
it gives a dedicated domain its own distribution tenant without touching
the pooled path. Pooled tenants add no CloudFront resource, which keeps
onboarding to one registrar call (P-9). Option 2 makes every dedicated
domain an edit to shared configuration; Option 3 breaks P-8 and P-9.

## Consequences

- Easier: one response headers policy and one set of origins for every
  tenant. A dedicated domain is one distribution tenant with its own
  certificate, an ACM certificate in `us-east-1` that the registrar
  requests across Regions. When the edge operator role sets
  `customDomain` with `PutTenantRoute`, the registrar writes the domain
  as `d` first, requests the certificate, and once it has validated
  creates the distribution tenant and writes the domain's `host#` key. A
  repeat finds what an earlier call made and creates only what is
  missing, so a pending call answers 202 again, not 409; a failed
  validation answers 422 (spec §3.4 step 5, §5.1).
- Harder: removal is two-phase. CloudFront deletes only a disabled
  distribution tenant and disabling deploys over minutes, so a dropped
  or changed domain, `DeleteTenantRoute` or `DeleteHostRoute` removes
  `host#<d>` and `d` at once and disables the distribution tenant, and
  the registrar's scheduled sweeper deletes it and then its certificate.
  A changed domain is offline from the change until the new one
  validates.
- Harder: distribution tenants the registrar creates are outside
  CloudFormation, and a distribution with distribution tenants cannot
  be deleted. A custom resource on the distribution disables and deletes
  every dedicated distribution tenant and its certificate before the
  distribution's delete (spec §6.2).
- Harder: only the vendor sets a dedicated domain. A tenant
  provisioning role that sends `customDomain` gets 403, so a tenant
  cannot claim a domain it does not own. The vendor sets it after it
  has confirmed that the tenant controls the domain; Q-3 decides how.
- Harder: the stack depends on multi-tenant distribution support in the
  CDK and CloudFormation version it pins.
- Harder: the dedicated path adds certificate validation per tenant
  domain, an ACM DNS record the tenant publishes in its own DNS, so the
  operator's `PutTenantRoute` answers 202 until it validates. Q-3
  decides whether the path ships in this sample.
- Follow-up: ADR-0003 and ADR-0004 assume this distribution type.
- Spike S-1 (2026-11-16): a viewer-request function with an associated
  KeyValueStore ran and read the store on an apex and a wildcard pooled
  distribution tenant of one `tenant-only` distribution, each named in a
  CNAME to the connection group's routing endpoint. The certificate for the
  apex and the wildcard takes one DNS validation entry, because both names
  share one validation record. Deploy 481 s, destroy 312 s.
- Revisit when distribution tenants cannot carry a feature the front door
  needs, or when the tenant count passes what one distribution tenant
  serves.

Amended 2026-11-17 by ADR-0017: no role of a cell account reaches the
registrar any more, provisioning roles included. The registrar's
callers are the control plane's global hook role, under which the
route hook runs, and the edge operator role. The global hook role that
sends `customDomain` gets 403, so only the edge operator role sets a
dedicated domain, as before.
