# Tenant Identity — Threat Model

> Status: **Implemented; reviewed 2026-10-21.** First written from
> [`design/tenant-identity.spec.md`](./design/tenant-identity.spec.md) and
> ADR-0001 to ADR-0014, then reconciled with the code. Every mitigation points
> at the spec requirement or ADR that motivates it and, where one exists, at
> the code and the test that implement it. Findings from the security review
> (standard §6) are dispositioned at the end.

Scope: the platform API (`/platform/*`), the token-exchange endpoint
(`POST /oauth2/token`), the tenant API (`/tenant/*`) and its authoriser,
the pre-token-generation trigger, the tenant registry, and the user pools
the sample creates, in all three topologies. Out of scope: the services
tenant users call with their tokens (ADR-0007), sign-in UI and
federation (spec §1.2), and the vendor's own identity (ADR-0005).

## Assets and trust boundaries

| Asset | Why it matters |
|---|---|
| Tenant claim in an access token (`tenant_id`, `tenants`) | Every downstream service scopes a request by it (spec §1) |
| Refresh tokens | Valid for 1 day (N-1); can be exchanged for any tenant and scope the user holds |
| Tenant registry | Source of tenant status; in `pool-per-tenant`, the issuer allowlist |
| User pools and groups | Hold the tenant assignment itself |
| Vendor IAM credential | Creates and deletes tenants, users, and (topology 1) pools |
| Tenant admin's narrowed token | Creates, changes, and deletes users of one tenant for up to 5 minutes |

| Boundary | Crossed by | Authenticated by |
|---|---|---|
| Vendor → platform API | SigV4 requests | IAM (ADR-0005) |
| Any caller → token exchange | Form POST | The refresh token, validated by Cognito (ADR-0009) |
| Any refresh-token holder → Cognito directly | `GetTokensFromRefreshToken` with `ClientMetadata` | The refresh token |
| Tenant admin → tenant API | Bearer token | The tenant authoriser (ADR-0007) |
| Cognito → trigger | V2 event | Lambda resource policy scoped to `cognito-idp.amazonaws.com` and the account |
| Token holder → consumer service | Bearer token | The consumer (out of scope) |

## Threats

| ID | Threat | Consequence | Status | Mitigations |
|---|---|---|---|---|
| T-1 | A multi-tenant token reaches a service that acts for one tenant | A leak from that service exposes every tenant the user belongs to; the service must be trusted to pick the right one | Mitigated by design; consumer must require `tenant_id`. No token carries `cognito:groups`, so a narrowed token names no other tenant (ADR-0020) | M-1, M-11 |
| T-2 | A refresh-token holder asks to narrow to a tenant or scope it does not hold, through the endpoint or straight to Cognito | Cross-tenant token signed by the trusted issuer. **Highest-consequence item.** | Mitigated by design | M-2 |
| T-3 | A tenant user changes their own tenant assignment (attribute update, self sign-up, group spoofing) | User acts for a tenant the vendor never assigned | Mitigated by design | M-3 |
| T-4 | An offboarded tenant keeps receiving tokens | Access continues after `DeleteTenant` | Mitigated for new tokens, and at once on `/tenant/*`; residual: tokens already issued stay valid up to 5 minutes elsewhere (accepted, README) | M-4, M-19 |
| T-5 | A token leaves a pool without a tenant claim, or from a pool the sample does not know | A consumer reads a missing or wrong tenant | Mitigated by design | M-5 |
| T-6 | The `IssueToken` and `RefreshToken` test aids mint tokens, including 1-day refresh tokens, for any user | A holder of the vendor's IAM permission can act as any tenant user | **Accepted for the sample**; removal is on the hardening checklist | M-6 |
| T-7 | Leaked vendor IAM credential | Tenants and users created or deleted; in topology 1, user pools created account-wide | Partially mitigated; `CreateUserPool` has no resource ARN and stays account-wide, and the `TagResource` it needs lets the role tag a foreign pool into its rights (both accepted, N-3) | M-6, M-7 |
| T-8 | The trigger function gains Cognito or write permissions | A bug or compromised dependency in the hottest code path could rewrite identity | Mitigated by design | M-8 |
| T-9 | Abuse of the unauthenticated exchange route: flooding, refresh-token guessing, error messages as an oracle | Cognito request quotas exhausted for all tenants; information leak | Partially mitigated; WAF is operational | M-9, M-10 |
| T-10 | Tokens or temporary passwords written to logs or caches | Logs become a credential store | Mitigated by design | M-10, M-22 |
| T-11 | A stolen refresh token | Up to 1 day of tokens for every tenant the user holds; refresh token rotation is off (ADR-0009) | Residual accepted; narrowing grants nothing the token did not already grant. Revocation is operational | M-2, M-4 |
| T-12 | A service that received a narrowed token extends or widens it | Narrowing undone downstream | Mitigated by design | M-12 |
| T-13 | A narrowed token carries `aws.cognito.signin.user.admin` | The service can call Cognito user APIs as the user (`GetUser`, `UpdateUserAttributes`) | Mitigated for narrowed tokens; un-narrowed tokens keep the scope (accepted: they go only to the client) | M-13 |
| T-14 | A consumer trusts the wrong issuer, e.g. any Cognito pool in topology 1 | Tokens from a pool the vendor does not control are accepted | Mitigated for `/tenant/*` (M-19); other consumers are out of scope, and the sample publishes what they need | M-11, M-19 |
| T-15 | Registry lost or corrupted | Topology 1 pools orphaned; trigger refuses every tenant | Mitigated by design | M-14 |
| T-16 | A platform operation on tenant A touches a user of tenant B (shared pools: `DeleteUser`, `DeleteMembership` with a username from another tenant) | Vendor-side cross-tenant deletion | Mitigated by design | M-15 |
| T-17 | `GetTokensFromRefreshToken` does not pass `ClientMetadata` to the trigger | The trigger issues an un-narrowed token and the endpoint returns it as narrowed: narrowing fails open | Mitigated by design; the integration test still proves the trigger path | M-2, M-16 |
| T-18 | A tenant admin reads or changes users of another tenant | Cross-tenant identity change by a tenant. The tenant-user role can reach every user in the pool (`shared-pool*`) or every pool of the stack (`pool-per-tenant`), so IAM does not stop it | Mitigated in code; the IAM gap is accepted and documented (P-8) | M-15, M-17, M-21 |
| T-19 | A user gains admin rights they were not given: a non-admin asks for `tenant-admin/users`, or an admin of A uses it on B | Privilege escalation inside or across tenants | Mitigated by design | M-2, M-18 |
| T-20 | A forged or foreign token reaches `/tenant/*`: an ID token, a token from another pool or app client, an un-narrowed token, a deleted tenant | Admin actions without a valid admin token | Mitigated by design | M-19 |
| T-21 | A tenant admin probes e-mail addresses with `CreateTenantUser` | Learns that an address already has an account with the vendor (409 in topology 2; no temporary password in topology 3) | **Accepted for the sample**; a real deployment sends invitations instead of returning passwords | — |
| T-22 | A tenant admin locks the tenant out by deleting or demoting the last admin | The tenant cannot manage its users | Mitigated by design; the vendor can restore an admin | M-20 |
| T-23 | Weak sign-in hardening: no MFA, Cognito threat protection off (the pools run the Essentials tier, the minimum for access-token customisation) | A tenant user's password is the only factor; credential stuffing and leaked passwords are not detected | **Accepted for the sample**; sign-in hardening is out of the identity-topology subject (spec §1.2) and is on the README hardening checklist. The cdk-nag `AwsSolutions-COG2`/`COG3`/`COG8` and cfn_nag `F78` suppressions cite this row | — |
| T-24 | Deferred operational hardening flagged by template scanners: CloudWatch Logs and Lambda environment variables use AWS-managed keys (no customer-managed KMS key); functions run outside a VPC with no reserved concurrency or DLQ; the API has no usage plan, API keys, or stage cache; functions use the AWS-managed basic-execution policy and X-Ray's `*` write actions | Weaker defence in depth for logs and functions; none of it changes who a token says the caller is | **Accepted for the sample**; out of the identity-topology subject (spec §1.2) and on the README hardening checklist. WAF is T-9 and sign-in hardening is T-23. Every cdk-nag, cfn_nag, and checkov suppression for these items cites this row; scanner false positives cite the ADR that explains them | — |
| T-25 | In `shared-pool-multi-tenant`, a tenant admin adds an existing user of another tenant by e-mail with `CreateTenantUser` | The user gains a membership they did not ask for, and the admin sees that user's status and creation date | **Accepted for the sample**: one identity in many tenants, added by an admin, is what this topology demonstrates (ADR-0001). A real deployment sends an invitation the user accepts before the membership is written; see also T-21 | — |

## Mitigations

"Operational" items are the deployer's and appear in the README's production
hardening checklist.

| ID | Mitigation | Where | Threats |
|---|---|---|---|
| M-1 | Narrow before the call: the client exchanges its refresh token for a token naming one tenant and a subset of scopes, signed by Cognito. The trigger removes `cognito:groups` from every token, so the narrowed token names no other tenant or admin group | P-10, §5.4, [ADR-0009](./adr/0009-narrow-tokens-by-token-exchange.md), [ADR-0020](./adr/0020-tokens-carry-no-cognito-groups.md); `src/trigger/pre-token-generation.ts` (`NO_GROUPS`); `test/trigger/pre-token-generation.test.ts`, `test/e2e/scenario.ts` | T-1 |
| M-2 | Narrowing only intersects: the trigger computes the user's `ACTIVE` tenants and §8.1 scopes, and refuses unless the request is a subset; only the two §8.2 keys are read. The endpoint holds no privilege, so a direct Cognito call gets the same answer. Property test and the §10 step 7 bypass test prove it | P-3, P-10, §8.2, [ADR-0010](./adr/0010-trigger-narrows-by-intersection.md); `src/trigger/pre-token-generation.ts` (`readNarrowRequest`, `applyNarrowing`, `resolveNarrowTenant`); `test/trigger/narrowing.property.test.ts`, `test/trigger/pre-token-generation.test.ts` (§8.2 refusals, P-3 clientMetadata isolation); spec §10 step 7 in `test/e2e/scenario.ts` | T-2, T-11 |
| M-3 | Tenant assignment only through Cognito admin paths: `custom:tenantId` immutable and not writable by the app client; self sign-up off; groups admin-only; only `^t-<ULID>$` groups count | P-3, R-5, §7.2, §7.3; `src/identity.cdk.ts` (shared pool: immutable `custom:tenantId`, not in the app client's write attributes, self sign-up off); `src/shared/constants.ts` (`TENANT_GROUP_PATTERN`); `test/identity.cdk.test.ts` (P-3 attribute test); spec §10 step 5 in `test/e2e/scenario.ts` | T-3 |
| M-4 | Offboarding at issuance: `DeleteTenant` flips `DELETING` with a conditional write before Cognito clean-up; the trigger reads the registry uncached on sign-in and refresh; access tokens last 5 minutes | P-2, R-11, N-1, N-9, [ADR-0008](./adr/0008-offboarding-enforced-at-issuance.md); `src/shared/registry.ts` (`markDeleting`, conditional write), `src/platform/platform.ts` (`DeleteTenant`), `src/trigger/pre-token-generation.ts` (`activeTenants`); `test/trigger/pre-token-generation.test.ts` (§8 status rules), `test/shared/registry.test.ts`; spec §10 steps 9 and 10 | T-4, T-11 |
| M-5 | Fail closed: any trigger exception fails the token request; an unknown `userPoolId` throws | §4.2, §8 (failure mode); `src/trigger/pre-token-generation.ts` (every refusal and lookup failure throws; `src/shared/registry.ts` `getByUserPoolId`); `test/trigger/pre-token-generation.test.ts` (§8 failure mode: errors propagate, never swallowed) | T-5 |
| M-6 | Test aids sit on the IAM-only platform API, are named test aids in the Smithy docs and README, never log tokens, and are listed for removal | [ADR-0006](./adr/0006-test-aid-routes-issue-and-refresh-tokens.md), §3.2; `src/platform/platform.ts` (`IssueToken`, `RefreshToken`), `src/identity.cdk.ts` (`TEST_AID_SIGN_IN_ACTIONS`, platform role only); `src/shared/logger.ts` drops token fields | T-6, T-7 |
| M-7 | Platform role scoped by `sample=tenant-identity` tag where actions take a resource; `/platform/*` throttled at 10 rps / 20 burst. Narrow IAM grants to `/platform/*` and CloudTrail review are operational | P-8, N-3, N-5, [ADR-0005](./adr/0005-vendor-authenticates-with-iam.md); `src/identity.cdk.ts` (platform role statements, `THROTTLE.platform`); `test/identity.cdk.test.ts` (N-3 tag-condition and pool-ARN tests) | T-7 |
| M-8 | Role asymmetry: the trigger role holds only registry reads and logging, no `cognito-idp`; the exchange role holds logging only. Unit tests assert both policies | P-8, R-14, R-7; `src/identity.cdk.ts` (`REGISTRY_READ_ACTIONS` for the trigger role; exchange role with no inline policy); `test/identity.cdk.test.ts` ("role asymmetry (P-8)") | T-8 |
| M-9 | The exchange route is throttled separately at 20 rps / 40 burst. AWS WAF on the API is operational | N-6; `src/identity.cdk.ts` (`THROTTLE.token`, per-method stage settings); `test/identity.cdk.test.ts` (API Gateway N-5..N-7) | T-9 |
| M-10 | No secrets in logs or caches: the trigger, platform, and exchange functions never log tokens, temporary passwords, or Cognito error text; `error_description` is fixed per code; responses carry `Cache-Control: no-store` | N-4, N-6, §5.4; `src/shared/logger.ts` (`FORBIDDEN_FIELD` drops token/password/secret fields; `errorName` logs the class only), `src/token-exchange/form.ts` (`OAUTH_ERROR_DESCRIPTIONS`), `src/token-exchange/token-exchange.ts` (`Cache-Control: no-store`); `test/token-exchange/handler.test.ts` (logging hygiene), `test/token-exchange/form.test.ts` (fixed descriptions) | T-9, T-10 |
| M-11 | One claim shape across topologies, with consumer guidance: a single-tenant consumer requires `tenant_id` and its scope; in topology 1, `ListTenants` is the issuer allowlist, and the only thing that stops trust in a deleted pool, because Cognito keeps serving its JWKS | P-6, §1.2, §4.1, [ADR-0007](./adr/0007-verify-tokens-only-on-the-tenant-api.md), [ADR-0018](./adr/0018-registry-allowlist-not-jwks-stops-trust.md); `src/shared/registry.ts` (`list`, behind `ListTenants`), `src/tenant-api/tenant-authorizer.ts` (pool-per-tenant: the registry, not the JWKS, decides whether the issuer is trusted); spec §10 step 9 in `test/e2e/scenario.ts` | T-1, T-14 |
| M-12 | No refresh token is issued with a narrowed token; the endpoint accepts only refresh tokens as subject, so an access token cannot be exchanged | P-10, §5.4 (`subject_token_type`); `src/token-exchange/form.ts` (`parseExchangeForm`), `src/token-exchange/token-exchange.ts` (returns `access_token` only); `test/token-exchange/form.test.ts` (subject_token_type), `test/token-exchange/token-exchange.test.ts` | T-12 |
| M-13 | Narrowed tokens suppress `aws.cognito.signin.user.admin`; §10 step 7 asserts `GetUser` is rejected | P-6, §8 (output); `src/shared/constants.ts` (`COGNITO_USER_ADMIN_SCOPE`), `src/trigger/pre-token-generation.ts` (`applyNarrowing` suppresses it); `test/trigger/pre-token-generation.test.ts` (§8.2 narrowing success) | T-13 |
| M-14 | Registry has point-in-time recovery; only the platform function writes it | R-3, N-2, R-14; `src/identity.cdk.ts` (registry table, PITR on; only the platform role holds write actions); `test/identity.cdk.test.ts` ("registry table (R-3, N-2, §4.2)") | T-15 |
| M-15 | Per-user platform operations check, through the provisioner, that the user belongs to the path's tenant, and answer 404 otherwise | R-12, [ADR-0013](./adr/0013-per-user-operations-check-tenant-membership.md); `src/topology/provisioner.ts` (`getUser` contract: `NotFoundError` when the user is not in the tenant) and its three implementations in `src/topology/`, `src/platform/platform.ts`; `test/topology/*.test.ts`, `test/platform/platform.test.ts`; spec §10 step 3 in `test/e2e/scenario.ts` | T-16 |
| M-16 | Narrowing fails closed: the exchange function decodes the token Cognito returned and answers `server_error` with no token unless `tenant_id`, `tenants`, and `scope` match the request | §5.4, [ADR-0012](./adr/0012-exchange-checks-the-narrowed-token.md); `src/token-exchange/token-exchange.ts` (`assertNarrowed`, `serverError`); `test/token-exchange/token-exchange.test.ts` ("reject tokens Cognito did not narrow") | T-17 |
| M-17 | Two front doors, one check: the tenant-user function takes the tenant only from the authoriser context, runs the R-12 membership check, and returns a User that never names other tenants | P-11, R-12, R-8, §5.1 (User shape), [ADR-0014](./adr/0014-tenant-admin-user-management.md); `src/tenant-api/tenant-users.function.ts` (context is the only tenant source), `src/tenant-api/tenant-users.ts`; `test/tenant-api/tenant-users.test.ts`, `test/tenant-api/tenant-users.function.test.ts`; spec §10 step 8 in `test/e2e/scenario.ts` | T-18 |
| M-18 | Admin is a per-tenant group, `admin-<tenantId>`; its scope is added only to narrowed tokens, and only for a member of that tenant's group | §8.1, §8.2, [ADR-0015](./adr/0015-tenant-admin-role-as-group-and-scope.md); `src/shared/constants.ts` (`ADMIN_GROUP_PATTERN`), `src/trigger/pre-token-generation.ts` (`scopesHeldFor`); `test/trigger/pre-token-generation.test.ts`; spec §10 step 8 in `test/e2e/scenario.ts` | T-19 |
| M-19 | Tenant authoriser: verifies signature, issuer, app client, `token_use`, `tenant_id`, no `tenants`, and `tenant-admin/users`; refuses a tenant that is not `ACTIVE`; no result cache; `/tenant/*` throttled | R-9, N-7, [ADR-0007](./adr/0007-verify-tokens-only-on-the-tenant-api.md); `src/tenant-api/tenant-authorizer.ts` (`authorize`), `src/tenant-api/tenant-authorizer.function.ts` (`buildPolicy`: every refusal is an explicit Deny, so the client sees 403 and no reason), `src/identity.cdk.ts` (`THROTTLE.tenant`), `model/tenant.smithy` (`resultTtlInSeconds: 0`, no result cache); `test/tenant-api/tenant-authorizer.test.ts`, `test/tenant-api/tenant-authorizer.function.test.ts`; spec §10 steps 8 and 9 in `test/e2e/scenario.ts` | T-4, T-14, T-20 |
| M-20 | A tenant admin cannot demote or delete themselves, so the tenant API always leaves an admin; the vendor's `UpdateUser` can restore one | R-13, `UpdateUser` in §5.1; `src/tenant-api/tenant-users.ts` (`resolveTarget`: resolves the path's `{username}`, `sub` or e-mail, to the canonical username and compares it with the caller's `sub`); `test/tenant-api/tenant-users.test.ts` | T-22 |
| M-21 | The tenant-user role holds no sign-in action: `AdminSetUserPassword` and `AdminInitiateAuth` sit in `TEST_AID_SIGN_IN_ACTIONS`, granted to the platform role only, so a bug in the tenant-user function cannot set another user's password or mint their tokens | P-8, R-8, M-17; `src/identity.cdk.ts` (`TENANT_USER_ACTIONS` vs `TEST_AID_SIGN_IN_ACTIONS`); `test/identity.cdk.test.ts` ("role asymmetry (P-8)") | T-6, T-18 |
| M-22 | The platform function logs no usernames or e-mail addresses: log lines carry `tenantId`, the operation, and the refusing rule only, so the vendor's logs are not a directory of tenant users. The tenant-user function logs the caller's `sub`, an opaque identifier, never the e-mail | N-4; `src/platform/platform.ts`, `src/tenant-api/tenant-users.ts`, `src/shared/logger.ts` | T-10 |

## Open items

- **T-17 residual.** Direct callers of `GetTokensFromRefreshToken` do not
  pass through the M-16 check. If Cognito dropped `ClientMetadata`, they
  would get a full token, which their refresh token already grants, so
  nothing widens (ADR-0012).
- **T-16 residual.** The membership check and the action are two Cognito
  calls; a concurrent membership change can race them. Accepted at vendor
  scale (ADR-0013).
- **T-18 residual.** In every topology the tenant boundary for the
  tenant-user function is enforced in code (the R-12 check against the
  authoriser's tenant), not by IAM. In `shared-pool*` its role can act on
  every user in the pool; in `pool-per-tenant` it can act on every pool this
  stack created. So a bug in the R-12 check is a cross-tenant bug. Unit tests
  cover the check per topology, and §10 step 8 tries it end to end.
  Hardening: per-tenant credentials through ABAC session tags.
- **Trigger invoke permission.** The trigger's resource policy lets
  `cognito-idp.amazonaws.com` invoke it for any user pool in this account
  (pool-per-tenant pools are created at runtime, so no pool ARN is known).
  A foreign pool that attaches it gets nothing: the trigger refuses a pool
  the registry does not know, and holds registry reads only. Accepted; the
  cost is noise.
- **T-6 (test aids).** The largest accepted risk. A deployment that keeps
  the platform API must delete both routes.
- **Refresh token rotation off.** Kept off so the exchange does not consume
  the client's refresh token (ADR-0009). A deployment that needs rotation
  revisits that record.

## Security review (2026-10-21)

Scanned the synthesised tree (`AWS_PROFILE=<deploy profile> npx projen
build`, so `cdk.out/` holds all three topology templates) with ProtoShield
v0.18.0 and ASH v3.2.0 (local mode). Scan outputs are not in the
repository.

| Scanner | Finding | Where | Outcome |
|---|---|---|---|
| ProtoShield license-headers | 56 "wrong licence" | every authored file | False positive: the plugin defaults to Apache 2.0. The repository is MIT-0 (`LICENSE`, standard §4.1). Re-run with `license_text=MIT-0`: 100% compliant, 0 findings. |
| ProtoShield IAM least privilege | `dynamodb:Scan` on the platform role is unused | `src/identity.cdk.ts` | False positive: `ListTenants` pages the registry with `ScanCommand` (`src/shared/registry.ts`, spec §4.3). |
| ProtoShield CVE / ASH npm-audit | `braces` 3.0.3 (high), `sprintf-js` 1.0.3 (medium), both denial of service | `package-lock.json` | Accepted: dev-only (`projen` → `micromatch`, `ts-jest` → `argparse`); `npm ls --omit=dev` finds neither, so neither is in a Lambda bundle. Both are the latest published versions; no fix exists. The input that triggers them never comes from a caller. |
| ProtoShield cdk-nag, checkov, semgrep, secrets | none | | 24 cdk-nag and 11 checkov suppressions reviewed by the tool; each cites an ADR or mitigation. |
| ASH checkov `CKV_OPENAPI_21` | arrays without `maxItems` | generated OpenAPI | Fixed: `TenantList` and `UserList` carry `@length(max: 100)` in `model/__global.smithy`. |
| ASH checkov `CKV_OPENAPI_4`, `CKV_OPENAPI_5` | no security on `POST /oauth2/token` | `TokenService.openapi.json` | Accepted by design: the refresh token in the body is the credential (ADR-0009, ADR-0011); the route is throttled (N-6). |
| ASH semgrep path traversal | `path.join(__dirname, ...)` | `src/identity.cdk.ts` | False positive: synth-time read of the generated OpenAPI; both parts are constants. |
| ASH detect-secrets | high-entropy strings | `cdk.out/`, the integ snapshot, `src/smithy/` | False positive: asset hashes in gitignored machine output. |
| ASH detect-secrets | high-entropy strings and "secret" keywords | `src/topology/cognito-users.ts`; tests | False positive: the password alphabet constants, synthetic ULIDs, and synthetic test passwords (`Synthetic-Pass-1!`). |
