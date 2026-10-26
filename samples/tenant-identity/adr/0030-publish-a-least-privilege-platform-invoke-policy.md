# ADR-0030: Publish a least-privilege managed policy for the platform calls of the mount

- Status: Proposed
- Date: 2026-10-26
- Deciders: Dave Roberts (SA)

## Context
The control-plane tenant build role must call `/platform/*` with SigV4. The resource policy allows the account root, so the caller needs an identity policy too. Control-plane must not write identity-shaped grants (its P-3).

## Options considered
### Option 1: Publish `PlatformInvokePolicy` and its ARN at `/application-plane/shared/identity/platformInvokePolicyArn`
The producer, who knows the routes, writes the least privilege (spec §6.3). The consumer attaches it generically. Con: one more shared parameter and one more managed policy per account.

### Option 2: The deployer writes an inline policy in control-plane context
No change here. Con: every deployer re-derives the route list, and the easy answer is `execute-api:Invoke` on `*`.

### Option 3: The resource policy names the build role
The grant lives on the API. Con: this stack must know the role ARN of the consumer, which inverts the dependency and breaks deploy order.

## Decision
Option 1 (spec M-P-4). The policy grants only the `CreateTenant`, `GetTenant`, `DeleteTenant`, `ListUsers`, `GetUser` and `CreateUser` routes, never `IssueToken`, `RefreshToken` or `ListTenants`.

## Consequences
execute-api ARNs cannot separate `DELETE /platform/tenants/{id}` from `DELETE /platform/tenants/{id}/users/{u}`, so `DeleteUser` is reachable; the threat model records it. The parameter is published only by the stack that owns the shared parameters (ADR-0017).
