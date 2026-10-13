# Tenant Identity — Architecture Decision Records

One file per decision, `NNNN-short-kebab-title.md`, four-digit numbers from
`0001`, never reused; the next number is the current maximum plus one.
Records are immutable once accepted: a change is a new record that supersedes
the old one. Cite inline as `(ADR-0004)`.

Template: [`docs/sample-standard.md` §2.2](../../../docs/sample-standard.md#2-design-trail).

| # | Title | Status | Date |
|---|---|---|---|
| [ADR-0001](0001-topology-is-a-deploy-time-choice.md) | Select the user-pool topology once, at deploy time, by CDK context | Accepted | 2026-10-13 |
| [ADR-0002](0002-verify-tokens-in-the-function-not-a-gateway-authoriser.md) | Verify bearer tokens inside the application function, not with an API Gateway JWT authoriser | Accepted | 2026-10-13 |
| [ADR-0003](0003-registry-holds-tenants-only.md) | Keep a tenant registry in DynamoDB, and make Cognito the only user store | Accepted | 2026-10-13 |
| [ADR-0004](0004-tenant-claims-via-pre-token-generation-v2.md) | Put the tenant claim into the access token with a V2 pre-token-generation trigger | Accepted | 2026-10-13 |
| [ADR-0005](0005-selection-header-narrows-never-widens.md) | Let the client select a tenant with a header that can only narrow the token's memberships | Accepted | 2026-10-13 |
| [ADR-0006](0006-synchronous-platform-api.md) | Make platform mutations synchronous | Accepted | 2026-10-13 |
| [ADR-0007](0007-operators-authenticate-with-iam.md) | Authenticate operators to the platform API with IAM, not a vendor IdP | Accepted | 2026-10-13 |
| [ADR-0008](0008-issue-token-test-aid.md) | Provide a server-side `IssueToken` route as a test aid, and label it as such | Accepted | 2026-10-13 |
