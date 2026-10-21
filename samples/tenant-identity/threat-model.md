# Tenant Identity — Threat Model

> Status: **Design stage, 2026-10-21.** Written from
> [`design/tenant-identity.spec.md`](./design/tenant-identity.spec.md) and
> ADR-0001 to ADR-0014 before any code exists. Every mitigation points at the
> spec requirement or ADR that will implement it; code locations, tests, and
> cdk-nag suppressions are added as the sample is built. Findings from the
> security review (standard §6) are dispositioned here.

Scope: the platform API (`/platform/*`), the token-exchange endpoint
(`POST /oauth2/token`), the pre-token-generation trigger, the tenant
registry, and the user pools the sample creates, in all three topologies.
Out of scope: whatever consumes the tokens (ADR-0007), sign-in UI and
federation (spec §1.2), and the vendor's own identity (ADR-0005).

## Assets and trust boundaries

| Asset | Why it matters |
|---|---|
| Tenant claim in an access token (`tenant_id`, `tenants`) | Every downstream service scopes a request by it (spec §1) |
| Refresh tokens | Valid for 1 day (N-1); can be exchanged for any tenant and scope the user holds |
| Tenant registry | Source of tenant status; in `pool-per-tenant`, the issuer allowlist |
| User pools and groups | Hold the tenant assignment itself |
| Vendor IAM credential | Creates and deletes tenants, users, and (topology 1) pools |

| Boundary | Crossed by | Authenticated by |
|---|---|---|
| Vendor → platform API | SigV4 requests | IAM (ADR-0005) |
| Any caller → token exchange | Form POST | The refresh token, validated by Cognito (ADR-0009) |
| Any refresh-token holder → Cognito directly | `GetTokensFromRefreshToken` with `ClientMetadata` | The refresh token |
| Cognito → trigger | V2 event | Lambda resource policy scoped to `cognito-idp.amazonaws.com` and the account |
| Token holder → consumer service | Bearer token | The consumer (out of scope) |

## Threats

| ID | Threat | Consequence | Status | Mitigations |
|---|---|---|---|---|
| T-1 | A multi-tenant token reaches a service that acts for one tenant | A leak from that service exposes every tenant the user belongs to; the service must be trusted to pick the right one | Mitigated by design; consumer must require `tenant_id` | M-1, M-11 |
| T-2 | A refresh-token holder asks to narrow to a tenant or scope it does not hold, through the endpoint or straight to Cognito | Cross-tenant token signed by the trusted issuer. **Highest-consequence item.** | Mitigated by design | M-2 |
| T-3 | A tenant user changes their own tenant assignment (attribute update, self sign-up, group spoofing) | User acts for a tenant the vendor never assigned | Mitigated by design | M-3 |
| T-4 | An offboarded tenant keeps receiving tokens | Access continues after `DeleteTenant` | Mitigated for new tokens; residual: tokens already issued stay valid up to 5 minutes (accepted, README) | M-4 |
| T-5 | A token leaves a pool without a tenant claim, or from a pool the sample does not know | A consumer reads a missing or wrong tenant | Mitigated by design | M-5 |
| T-6 | The `IssueToken` and `RefreshToken` test aids mint tokens, including 1-day refresh tokens, for any user | A holder of the vendor's IAM permission can act as any tenant user | **Accepted for the sample**; removal is on the hardening checklist | M-6 |
| T-7 | Leaked vendor IAM credential | Tenants and users created or deleted; in topology 1, user pools created account-wide | Partially mitigated; `CreateUserPool` has no resource ARN and stays account-wide (accepted, N-4) | M-6, M-7 |
| T-8 | The trigger function gains Cognito or write permissions | A bug or compromised dependency in the hottest code path could rewrite identity | Mitigated by design | M-8 |
| T-9 | Abuse of the unauthenticated exchange route: flooding, refresh-token guessing, error messages as an oracle | Cognito request quotas exhausted for all tenants; information leak | Partially mitigated; WAF is operational | M-9, M-10 |
| T-10 | Tokens or temporary passwords written to logs or caches | Logs become a credential store | Mitigated by design | M-10 |
| T-11 | A stolen refresh token | Up to 1 day of tokens for every tenant the user holds; refresh token rotation is off (ADR-0009) | Residual accepted; narrowing grants nothing the token did not already grant. Revocation is operational | M-2, M-4 |
| T-12 | A service that received a narrowed token extends or widens it | Narrowing undone downstream | Mitigated by design | M-12 |
| T-13 | A narrowed token carries `aws.cognito.signin.user.admin` | The service can call Cognito user APIs as the user (`GetUser`, `UpdateUserAttributes`) | Mitigated for narrowed tokens; un-narrowed tokens keep the scope (accepted: they go only to the client) | M-13 |
| T-14 | A consumer trusts the wrong issuer, e.g. any Cognito pool in topology 1 | Tokens from a pool the vendor does not control are accepted | Out of scope (ADR-0007); the sample publishes what a consumer needs | M-11 |
| T-15 | Registry lost or corrupted | Topology 1 pools orphaned; trigger refuses every tenant | Mitigated by design | M-14 |
| T-16 | A platform operation on tenant A touches a user of tenant B (shared pools: `DeleteUser`, `RemoveMembership` with a username from another tenant) | Vendor-side cross-tenant deletion | Mitigated by design | M-15 |
| T-17 | `GetTokensFromRefreshToken` does not pass `ClientMetadata` to the trigger | The trigger issues an un-narrowed token and the endpoint returns it as narrowed: narrowing fails open | Mitigated by design; the integration test still proves the trigger path | M-2, M-16 |

## Mitigations

"Operational" items are the deployer's and appear in the README's production
hardening checklist.

| ID | Mitigation | Where | Threats |
|---|---|---|---|
| M-1 | Narrow before the call: the client exchanges its refresh token for a token naming one tenant and a subset of scopes, signed by Cognito | P-10, §5.5, [ADR-0009](./adr/0009-narrow-tokens-by-token-exchange.md) | T-1 |
| M-2 | Narrowing only intersects: the trigger computes the user's `ACTIVE` tenants and §8.1 scopes, and refuses unless the request is a subset; only the two §8.2 keys are read. The endpoint holds no privilege, so a direct Cognito call gets the same answer. Property test and the §10 step 6a bypass test prove it | P-3, P-10, §8.2, [ADR-0010](./adr/0010-trigger-narrows-by-intersection.md); spec §10 step 6a | T-2, T-11 |
| M-3 | Tenant assignment only through Cognito admin paths: `custom:tenantId` immutable and not writable by the app client; self sign-up off; groups admin-only; only `^t-<ULID>$` groups count | P-3, R-6, §7.2, §7.3; spec §10 step 5 | T-3 |
| M-4 | Offboarding at issuance: `DeleteTenant` flips `DELETING` with a conditional write before Cognito clean-up; the trigger reads the registry uncached on sign-in and refresh; access tokens last 5 minutes | P-2, R-9, N-1, N-9, [ADR-0010](./adr/0010-trigger-narrows-by-intersection.md); spec §10 steps 7 and 8 | T-4, T-11 |
| M-5 | Fail closed: any trigger exception fails the token request; an unknown `userPoolId` throws | §4.2, §8 (failure mode) | T-5 |
| M-6 | Test aids sit on the IAM-only platform API, are named test aids in the Smithy docs and README, never log tokens, and are listed for removal | [ADR-0012](./adr/0012-test-aid-returns-refresh-token.md), §3.2 | T-6, T-7 |
| M-7 | Platform role scoped by `sample=tenant-identity` tag where actions take a resource; `/platform/*` throttled at 10 rps / 20 burst. Narrow IAM grants to `/platform/*` and CloudTrail review are operational | P-8, N-4, N-7, [ADR-0005](./adr/0005-vendor-authenticates-with-iam.md) | T-7 |
| M-8 | Role asymmetry: the trigger role holds only registry reads and logging, no `cognito-idp`; the exchange role holds logging only. Unit tests assert both policies | P-8, R-11, R-12 | T-8 |
| M-9 | The exchange route is throttled separately at 20 rps / 40 burst. AWS WAF on the API is operational | N-10 | T-9 |
| M-10 | No secrets in logs or caches: the trigger, platform, and exchange functions never log tokens, temporary passwords, or Cognito error text; `error_description` is fixed per code; responses carry `Cache-Control: no-store` | N-6, N-10, §5.5 | T-9, T-10 |
| M-11 | One claim shape across topologies, with consumer guidance: a single-tenant consumer requires `tenant_id` and its scope; in topology 1, `ListTenants` is the issuer allowlist | P-6, §1.2, §4.1, [ADR-0007](./adr/0007-token-consumption-out-of-scope.md) | T-1, T-14 |
| M-12 | No refresh token is issued with a narrowed token; the endpoint accepts only refresh tokens as subject, so an access token cannot be exchanged | P-10, §5.5 (`subject_token_type`) | T-12 |
| M-13 | Narrowed tokens suppress `aws.cognito.signin.user.admin`; §10 step 6a asserts `GetUser` is rejected | P-6, §8 (output) | T-13 |
| M-14 | Registry has point-in-time recovery; only the platform function writes it | R-4, N-3, R-11 | T-15 |
| M-15 | Per-user platform operations check, through the provisioner, that the user belongs to the path's tenant, and answer 404 otherwise | R-13, [ADR-0014](./adr/0014-per-user-operations-check-tenant-membership.md); spec §10 step 3 | T-16 |
| M-16 | Narrowing fails closed: the exchange function decodes the token Cognito returned and answers `server_error` with no token unless `tenant_id`, `tenants`, and `scope` match the request | §5.5, [ADR-0013](./adr/0013-exchange-checks-the-narrowed-token.md); spec §10 unit list | T-17 |

## Open items

- **T-17 residual.** Direct callers of `GetTokensFromRefreshToken` do not
  pass through the M-16 check. If Cognito dropped `ClientMetadata`, they
  would get a full token, which their refresh token already grants, so
  nothing widens (ADR-0013).
- **T-16 residual.** The membership check and the action are two Cognito
  calls; a concurrent membership change can race them. Accepted at vendor
  scale (ADR-0014).
- **T-6 (test aids).** The largest accepted risk. A deployment that keeps
  the platform API must delete both routes.
- **Refresh token rotation off.** Kept off so the exchange does not consume
  the client's refresh token (ADR-0009). A deployment that needs rotation
  revisits that record.
