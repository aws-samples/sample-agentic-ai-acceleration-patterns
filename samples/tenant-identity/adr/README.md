# Tenant Identity — Architecture Decision Records

One file per decision, `NNNN-short-kebab-title.md`, four-digit numbers from
`0001`, never reused; the next number is the current maximum plus one.
Records are immutable once accepted: a change is a new record that supersedes
the old one. Cite inline as `(ADR-0003)`.

Template: [`docs/sample-standard.md` §2.2](../../../docs/sample-standard.md#2-design-trail).

| # | Title | Status | Date |
|---|---|---|---|
| [ADR-0001](0001-topology-is-a-deploy-time-choice.md) | Select the user-pool topology once, at deploy time, by CDK context | Accepted | 2026-10-13 |
| [ADR-0002](0002-registry-holds-tenants-only.md) | Keep a tenant registry in DynamoDB, and make Cognito the only user store | Accepted | 2026-10-13 |
| [ADR-0003](0003-tenant-claims-via-pre-token-generation-v2.md) | Put the tenant claim into the access token with a V2 pre-token-generation trigger | Accepted | 2026-10-13 |
| [ADR-0004](0004-synchronous-platform-api.md) | Make platform mutations synchronous | Accepted | 2026-10-13 |
| [ADR-0005](0005-vendor-authenticates-with-iam.md) | Authenticate the vendor to the platform API with IAM, not a vendor IdP | Accepted | 2026-10-13 |
| [ADR-0006](0006-issue-token-test-aid.md) | Provide a server-side `IssueToken` route as a test aid, and label it as such | Accepted | 2026-10-13 |
| [ADR-0007](0007-token-consumption-out-of-scope.md) | Keep token consumption out of the sample; the integration test verifies tokens | Accepted | 2026-10-14 |
| [ADR-0008](0008-offboarding-enforced-at-issuance.md) | Enforce tenant offboarding at issuance, in the pre-token-generation trigger | Accepted | 2026-10-14 |
