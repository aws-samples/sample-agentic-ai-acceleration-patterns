# ADR-0030: Publish a least-privilege managed policy for the platform calls of the mount

- Status: Accepted
- Date: 2026-10-26
- Deciders: Dave Roberts (SA)

## Context
The control-plane tenant build role must call `/platform/*` with SigV4. The resource policy allows the account root, so the caller needs an identity policy too. Control-plane must not write identity-shaped grants (its P-3).

## Options considered
### Option 1: Publish `PlatformInvokePolicy` and its ARN at `/application-plane/shared/identity/platformInvokePolicyArn`
The producer, who knows the routes, writes the least privilege (spec §6.3). The consumer attaches it generically. The same policy carries the `kms:Encrypt`/`kms:GenerateDataKey` grant on `AdminPasswordKey` (ADR-0033), scoped to `kms:ViaService = ssm`, so the consumer still attaches one ARN. Con: one more shared parameter and one more managed policy per account.

### Option 2: The deployer writes an inline policy in control-plane context
No change here. Con: every deployer re-derives the route list, and the easy answer is `execute-api:Invoke` on `*`.

### Option 3: The resource policy names the build role
The grant lives on the API. Con: this stack must know the role ARN of the consumer, which inverts the dependency and breaks deploy order.

## Decision
Option 1 (spec M-P-4). The policy grants only the `CreateTenant`, `GetTenant`, `DeleteTenant` and `CreateUser` routes plus encrypt-through-SSM on the password key; never `IssueToken`, `RefreshToken`, `ListTenants` or `kms:Decrypt`. `ListUsers` and `GetUser` are reachable only because `GET /platform/tenants/*` cannot exclude them; the mount never calls them (ADR-0032 removed the need).

## Consequences
execute-api ARNs cannot separate `DELETE /platform/tenants/{id}` from `DELETE /platform/tenants/{id}/users/{u}`, so `DeleteUser`, `ListUsers` and `GetUser` are reachable; `threat-model.md` records the over-grant in the same PR that adds the policy (sample standard §2.4). The parameter is published only by the stack that owns the shared parameters (ADR-0017).
