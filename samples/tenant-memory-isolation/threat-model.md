<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Threat model

| Threat | Mitigation | Implemented by |
| --- | --- | --- |
| T-1: A caller forges or widens its tenant or session | M-1: The issuer sets `tenant_id` from a vendor-set, immutable attribute; the Gateway validates the JWT; Cedar compares `actorId`, `sessionId`, and `namespace` with the claims; one claim decides actor and namespace | ADR-0009; `src/issuer/pre-token.function.ts`; `src/policies.ts`; `test/policies.test.ts`; integ steps 2-5 |
| T-2: A broad, nested, or prefix namespace leaks another tenant | M-2: Exact `namespace` only, `namespacePath` refused; tenant ids without `/`, `:`, `*` | `src/policies.ts` `claimConditions`, `sharedRecallPolicy`; integ steps 5-6 (tenant-a vs tenant-ab) |
| T-3: Record-ID, enumeration, event-read, batch, or ingestion access avoids the tenant checks | M-3: No permits for the nine other connector operations; batch and `IngestData` are not connector operations and are fenced (M-4); the role holds three actions | ADR-0005; `src/tenant-memory-isolation.ts` `AgentMemoryOperations`; integ steps 5, 7, 8 |
| T-4: A principal in the vendor account calls Memory directly | M-4: Resource policy denies all 16 data operations unless `aws:PrincipalArn` is the Gateway role; the fence list is checked against the pinned SDK | ADR-0004, ADR-0007; `src/fence.ts`; `test/fence.test.ts`; integ step 8 |
| T-5: A caller obtains the Gateway role | M-5: The role trusts only the AgentCore service for this account, this Gateway's name pattern, and its Policy engine, from the first deploy | ADR-0011; `test/construct.test.ts`; integ steps 1, 8 |
| T-6: Configuration drift widens access | M-6: Policies `FAIL_ON_ANY_FINDINGS`; construct tests on every grant and condition; production monitoring of the fence, role, and policies | `test/construct.test.ts`; production hardening |
| T-7: An agent writes misleading facts into its tenant's shared memory | Accepted: any user of a tenant may write events that become facts for the whole tenant; extraction overrides are denied (M-7) so facts land only in the writer's own tenant | `src/policies.ts` `eventWritePolicy`; provenance and review are the vendor's (production hardening) |
| T-8: An ID token or another client's token is accepted | M-8: `allowedClients`; Cedar requires `token_use == "access"` | `src/tenant-memory-isolation.ts`; integ step 4 |
| T-9: Errors, logs, or reports disclose tokens or memory content | M-9: Generic Gateway errors (no `exceptionLevel`); Gateway application logs off; scripts print names and statuses only; Memory application logs carry ids and counts | ADR-0012; `scripts/CONVENTIONS.md`; integ step 13 |
| T-10: An expired token keeps working | M-10: The Gateway's authoriser validates expiry before Policy runs; demo tokens last five minutes | integ step 12: the expired token is refused with the Bearer `invalid_token` challenge while a fresh token on the same request is allowed |
| T-11: One tenant exhausts shared capacity | M-11: Per-tenant Gateway rate limit on `tenant_id` (fairness, not isolation) | `CfnGatewayRateLimit`; construct test |
| T-12: Memory data at rest under a key the vendor does not control | Accepted for the sample: AgentCore encrypts at rest with an AWS-owned key; M-12 a customer-managed key is a production option | production hardening |
| T-13: A Memory operation ships before the pinned SDK knows it | Accepted: the fence covers what the SDK models; the fence test forces review on each SDK upgrade | ADR-0007 |

## Security review

Scans run 2026-11-10 on this branch after `npx projen build` under the
deployment profile (`cdk.out/` synthesised for the test account in
`us-east-1`):

- **ASH v3.7.1** (`awslabs/automated-security-helper`, container mode, config
  [`.ash/.ash.yaml`](.ash/.ash.yaml)): bandit, cdk-nag, cfn-nag, checkov,
  detect-secrets, grype, npm-audit, opengrep, semgrep, syft. The summary is
  in the pull request description (scanner output stays out of the
  repository). Exit 2: six actionable findings, all dispositioned below.
- **cdk-nag `AwsSolutionsChecks`** in the build (`src/main.ts`): no
  unacknowledged finding.
- **ProtoShield:** not run (no public install path); the pull request
  description says so.

| Scanner | Finding | Disposition |
| --- | --- | --- |
| cdk-nag (build) | IAM5 on the pre-token role's log-stream ARN (`<log group>:*`) | Accepted: the function's own log group; Lambda names streams at run time (acknowledged in `src/demo.cdk.ts`) |
| cdk-nag (build) | COG2 (MFA), COG3 (threat protection), COG8 (Plus tier) on the demo user pool | Accepted for the synthetic issuer: no self sign-up, no hosted sign-in, admin-created users; Essentials is the tier with access-token customisation; a production issuer brings its own (M-1, production hardening) |
| ASH cdk-nag | ERROR: the wrapper parsed `tsconfig.json`, `test/tsconfig.json`, `projenrc/tsconfig.json`, and `.eslintrc.json` as templates and evaluated no rule | Tooling, not a finding: the same rule pack runs in the build on the synthesised app, clean |
| checkov CKV_AWS_158 (×2) | Both log groups use CloudWatch Logs' default encryption, not a customer-managed key | Accepted: encrypted at rest by default; the logs carry ids and counts, never tokens or content (M-9, integ step 13); a customer-managed key is production hardening (M-12) |
| checkov CKV_AWS_117 | The pre-token Lambda is not in a VPC | False positive for this function: it calls no network resource |
| checkov CKV_AWS_116 | The pre-token Lambda has no DLQ | Not applicable: Cognito invokes it synchronously; a failure stops token issuance |
| checkov CKV_AWS_115 | The pre-token Lambda has no reserved concurrency | Accepted for the demo issuer; sign-in volume is the issuer's concern in production |
| grype GHSA-g3hv-75wg-m249 | `minimatch` (medium) in `package-lock.json`, through jest, eslint, aws-cdk-lib, and cdk-nag | Accepted: build-time only; nothing ships to AWS but the 8 KB bundled trigger, which has no dependencies; versions are pinned to the repository's shared set (aws-cdk-lib 2.274.0, cdk-nag 3.0.2) |
| bandit, cfn-nag, detect-secrets, npm-audit (at MEDIUM), opengrep, semgrep, syft | No actionable findings | — |
