<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Threat model

| Threat | Mitigation | Implemented by |
| --- | --- | --- |
| T-1: A caller forges tenant or session scope, or an issuer bug pairs one tenant's actor with another's namespace | M-1: Issuer controls claims and builds actor, session, and namespace from one tenant id; Gateway validates JWTs; Cedar checks each request field against its claim | ADR-0001; `src/test_identity.py` `scope_claims`; `policies/*.cedar`; `test/policy.test.cjs` |
| T-2: Broad or nested namespace retrieval leaks another tenant | M-2: Exact `namespacePath` match, no `namespace` alias, actor claims of one path segment, namespace claims of exactly `/tenants/<segment>/shared/` | `policies/shared-recall.cedar`, `policies/event-write.cedar`; Cedar allow and deny tests |
| T-3: Record-ID, batch, ingestion, or event-read access avoids namespace checks | M-3: No tenant permits for those operations; the role grants only the three agent operations | ADR-0005; `src/render_config.py`; Cedar no-permit tests; live probes |
| T-4: A direct IAM call bypasses Gateway | M-4: Resource policy denies every data operation in the service model outside the exact execution role; service-only role trust pins account, Gateway, and Policy engine | ADR-0004, ADR-0007; `test/test_fence.py`; live probes that run only when the caller's own policies would allow the call |
| T-5: Role or Policy drift widens access | M-5: Narrow role, Gateway and Memory literals, `ENFORCE`, `ACTIVE` policies with `FAIL_ON_ANY_FINDINGS` | Config tests; `assert_execution_role` in the live preflight |
| T-6: Failed extraction or cleanup is mistaken for isolation | M-6: Positive canary checks, bounded extraction wait, `NOT_RUN` recorded for probes that cannot prove their claim, teardown deletes every journalled resource | `src/validate_live.py`, `src/live_environment.py` |
| T-7: An agent writes misleading facts into its tenant's shared memory | Accepted: any agent of a tenant may write events that the strategy extracts for every agent of that tenant; extraction overrides are denied (M-7) | `policies/event-write.cedar`; provenance and write approval are the vendor's (production hardening) |
| T-8: A shared cache mixes bearer tokens or recalled content | M-8: Client holds one supplied token, no response cache, never follows redirects | `src/gateway_memory.py`; tests |
| T-9: Logs, errors, or reports disclose credentials or data | M-9: Case names and status only; diagnostics redact bearer tokens; Gateway uses the default exception level | `src/validate_live.py`, `src/gateway_memory.py`, `scripts/CONVENTIONS.md` |
| T-10: An expired or replayed token keeps working | M-10: Gateway validates expiry; tokens last 60 minutes; the live probe requires 401 on a permitted request | `src/validate_live.py` `expect_unauthenticated` |

A Memory data operation the service ships before the pinned SDK models it is
not in the fence until the pin moves (ADR-0007). During Gateway creation the
role trust and Policy evaluation permissions cover the account's Gateways in
the Region; the driver narrows both before the Memory target exists
(ADR-0003).

No production security scan has been run on this tree yet.
