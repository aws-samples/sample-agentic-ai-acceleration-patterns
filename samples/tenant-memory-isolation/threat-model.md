<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Threat model

| Threat | Mitigation | Evidence/status |
| --- | --- | --- |
| T-1: A caller forges tenant or session scope | M-1: Issuer controls claims; Gateway validates JWTs; Cedar checks exact scopes | `policies/*.cedar`; issuer implementation and JWT handling require live validation |
| T-2: Broad namespace retrieval leaks another tenant | M-2: Exact canonical namespacePath, absent namespace alias, unambiguous tenant segments | `shared-recall.cedar`; real Cedar allow/deny tests |
| T-3: Record-ID or batch access avoids namespace checks | M-3: No tenant permits for record IDs/admin; role omits batch APIs | `render_config.py`, policy tests; live ID and direct-bypass probes |
| T-4: Direct IAM call bypasses Gateway | M-4: Explicit data-plane Deny outside the exact execution role; service-only role trust pins source account and Gateway/Policy ARNs | `render_config.py`; live harness checks permissions/trust and probes direct Memory access and role assumption |
| T-5: Role or Policy drift widens access | M-5: Narrow role, Gateway/Memory literals, ENFORCE, ACTIVE policies with fail-on-findings | Config tests; drift monitoring is a production requirement |
| T-6: Failed extraction or cleanup is mistaken for isolation | M-6: Positive canary checks, bounded extraction wait, status report, dedicated Memory teardown | `validate_live.py`; long-term deletion requires test resource teardown |
| T-7: An agent poisons shared organisational facts | M-7: Share only deliberate synthetic facts; forbid namespace variable overrides | `event-write.cedar`; production provenance/write approval is not implemented |
| T-8: A shared cache mixes bearer tokens or recalled content | M-8: Client holds one supplied token; no response cache; never follows redirects | `gateway_memory.py`, tests; production caches must key on authorised sharing scope |
| T-9: Logs or reports disclose credentials/data | M-9: Print case names/status only; report has no tokens or memory contents | `validate_live.py`, script conventions |

The disposable driver keeps resource journals and bounded failure diagnostics in
ignored local files. Gateway diagnostic bodies redact bearer tokens. The initial
positive write retries with a stable idempotency token; persistent denial fails,
and negative probes never use that retry.

No production security scan or service integration review has been claimed.
The resource fence must be extended if new Memory data APIs are introduced.
Short-term event reads and deletion are denied to agents because the native
connector did not expose their path tenant keys to Policy during live
validation. Deleting the dedicated test Memory removes its synthetic events.
