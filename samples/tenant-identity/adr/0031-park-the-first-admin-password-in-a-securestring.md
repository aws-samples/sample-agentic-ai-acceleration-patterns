# ADR-0031: Park the temporary password of the first admin in an SSM SecureString

- Status: Proposed
- Date: 2026-10-26
- Deciders: Dave Roberts (SA)

## Context
Every topology creates users with `MessageAction: SUPPRESS` and returns the temporary password only in the `CreateTenant` response. Mounted, that response lands in a CodeBuild script, where nobody reads it. Build logs are readable by anyone with log-group access (control-plane `scripts/CONVENTIONS.md`).

## Options considered
### Option 1: SecureString at `/application-plane/tenants/<T>/identity/admin-temporary-password`
Inside the namespace the tenant build role already owns; encrypted; deleted by `tenant/delete.sh`. Con: readable by any principal with that path and the default key, including the shared build role (spec §9 gap 3).

### Option 2: Let Cognito email the invitation
The real-world path; the script holds nothing. Con: a change to every topology, the daily quota of the Cognito default sender, and an SES-backed sender for the simulator addresses the tests use.

### Option 3: Discard the password
Nothing secret stored. Con: the admin is locked out until the vendor runs `DeleteUser` and `CreateUser` by hand, which defeats one-call onboarding.

## Decision
Option 1 for the sample, with option 2 as a hardening item. It keeps one-call onboarding, and the integration test can sign the admin in (spec §10 step 6).

## Consequences
A build killed between the 201 and the park loses the password (spec §9 gap 1). Hardening: a customer KMS key the build role may encrypt with but not decrypt, or option 2. The value never appears in a log: `put-parameter` output goes to `/dev/null`.
