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
| [ADR-0003](0003-tenant-claims-via-pre-token-generation-v2.md) | Put tenant identity into the access token with a V2 pre-token-generation trigger | Superseded by ADR-0020 | 2026-10-21 |
| [ADR-0004](0004-synchronous-platform-api.md) | Make platform mutations synchronous | Accepted | 2026-10-13 |
| [ADR-0005](0005-vendor-authenticates-with-iam.md) | Authenticate the vendor to the platform API with IAM, not a vendor IdP | Accepted | 2026-10-13 |
| [ADR-0006](0006-test-aid-routes-issue-and-refresh-tokens.md) | Provide `IssueToken` and `RefreshToken` test-aid routes on the platform API | Accepted | 2026-10-21 |
| [ADR-0007](0007-verify-tokens-only-on-the-tenant-api.md) | Verify tokens only on `/tenant/*`, in one Lambda authoriser; build no consumer for tenant services | Accepted | 2026-10-21 |
| [ADR-0008](0008-offboarding-enforced-at-issuance.md) | Enforce tenant offboarding at issuance, in the pre-token-generation trigger | Accepted | 2026-10-21 |
| [ADR-0009](0009-narrow-tokens-by-token-exchange.md) | Narrow tokens by RFC 8693 token exchange, with Cognito re-issuing the token | Accepted | 2026-10-20 |
| [ADR-0010](0010-trigger-narrows-by-intersection.md) | Narrow in the pre-token-generation trigger by intersecting the request with what the user holds | Accepted | 2026-10-21 |
| [ADR-0011](0011-token-endpoint-in-smithy-with-form-payload.md) | Model the token-exchange endpoint in Smithy with a form-encoded blob payload | Accepted | 2026-10-20 |
| [ADR-0012](0012-exchange-checks-the-narrowed-token.md) | Make the exchange endpoint check that Cognito actually narrowed the token | Accepted | 2026-10-21 |
| [ADR-0013](0013-per-user-operations-check-tenant-membership.md) | Check that a user belongs to the path's tenant before any per-user platform operation | Accepted | 2026-10-21 |
| [ADR-0014](0014-tenant-admin-user-management.md) | Let a tenant admin manage their own tenant's users, through a second front door to the provisioner | Accepted | 2026-10-21 |
| [ADR-0015](0015-tenant-admin-role-as-group-and-scope.md) | Make tenant admin a per-tenant group, and grant its scope only on narrowed tokens | Accepted | 2026-10-21 |
| [ADR-0016](0016-one-rest-api-from-three-smithy-services.md) | Serve the three route families from one REST API built from three Smithy services | Accepted | 2026-10-21 |
| [ADR-0017](0017-one-stack-per-account-publishes-shared-parameters.md) | Let only one stack per account and Region publish the shared identity parameters | Accepted | 2026-10-21 |
| [ADR-0018](0018-registry-allowlist-not-jwks-stops-trust.md) | Rely on the registry allowlist, not a vanished JWKS, to stop trust in a deleted pool | Accepted | 2026-10-21 |
| [ADR-0019](0019-teardown-leaves-no-log-group.md) | Delete log groups only after their writers have stopped, and leave the account's API Gateway role alone | Accepted | 2026-10-21 |
| [ADR-0020](0020-tokens-carry-no-cognito-groups.md) | Remove `cognito:groups` from every token the trigger issues | Accepted | 2026-10-22 |
| [ADR-0021](0021-registry-row-before-provisioning.md) | Write the registry row before provisioning Cognito | Accepted | 2026-10-22 |
| [ADR-0022](0022-drain-registry-on-stack-delete.md) | Drain the registry on stack delete | Accepted | 2026-10-22 |
| [ADR-0023](0023-integ-with-cdk-cli.md) | Drive the integration test with the CDK CLI, not integ-runner | Accepted | 2026-10-22 |
| [ADR-0024](0024-one-log-drain.md) | Use one log drain whose writers are what invokes the functions | Accepted | 2026-10-22 |
| [ADR-0025](0025-per-tenant-throttling-with-usage-plan-keys.md) | Throttle `/tenant/*` per tenant with one usage plan and an API key per tenant | Accepted | 2026-10-22 |
| [ADR-0026](0026-iam-tenant-boundary-for-pool-per-tenant.md) | Enforce the tenant boundary of tenant-user calls with IAM in `pool-per-tenant` | Accepted | 2026-10-22 |
| [ADR-0027](0027-mixed-tier-deployment.md) | Serve a standard and a premium tier from one deployment, chosen per tenant | Accepted | 2026-10-23 |
| [ADR-0028](0028-ship-the-control-plane-mount-in-this-sample.md) | Ship the control-plane mount as `scripts/control-plane/` in this sample | Accepted | 2026-10-26 |
| [ADR-0029](0029-accept-a-caller-supplied-tenant-id.md) | Accept an optional caller-supplied `tenantId` on `CreateTenant` | Accepted | 2026-10-26 |
| [ADR-0030](0030-publish-a-least-privilege-platform-invoke-policy.md) | Publish a least-privilege managed policy for the platform calls of the mount | Accepted | 2026-10-26 |
| [ADR-0031](0031-park-the-first-admin-password-in-a-securestring.md) | Park the temporary password of the first admin in an SSM SecureString | Accepted | 2026-10-26 |
| [ADR-0032](0032-make-the-first-admin-a-conditional-write.md) | Make the first admin a conditional write on the registry row | Accepted | 2026-10-26 |
| [ADR-0033](0033-encrypt-the-parked-password-with-a-customer-key.md) | Encrypt the parked admin password with a key the build role cannot decrypt | Accepted | 2026-10-26 |
| [ADR-0034](0034-backends-register-their-scopes-in-a-catalogue.md) | Let backends register their own scopes in a catalogue through the platform API | Accepted | 2026-10-29 |
| [ADR-0035](0035-entitle-scopes-per-tenant-on-the-registry-row.md) | Entitle scopes per tenant on the registry row | Accepted | 2026-10-29 |
| [ADR-0036](0036-let-tenant-admins-cut-user-scopes-with-a-cognito-attribute.md) | Let tenant admins cut a user's scopes with a Cognito attribute | Accepted | 2026-10-29 |
