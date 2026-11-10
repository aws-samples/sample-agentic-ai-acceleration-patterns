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
| T-10: An expired token keeps working | M-10: The Gateway validates expiry; demo tokens last five minutes | integ step 12 |
| T-11: One tenant exhausts shared capacity | M-11: Per-tenant Gateway rate limit on `tenant_id` (fairness, not isolation) | `CfnGatewayRateLimit`; construct test |
| T-12: Memory data at rest under a key the vendor does not control | Accepted for the sample: AgentCore encrypts at rest with an AWS-owned key; M-12 a customer-managed key is a production option | production hardening |
| T-13: A Memory operation ships before the pinned SDK knows it | Accepted: the fence covers what the SDK models; the fence test forces review on each SDK upgrade | ADR-0007 |

## Security review

No scan of the synthesised tree has been dispositioned yet; findings will be
recorded here.
