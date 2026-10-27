<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Validation evidence — 26 October 2026

The reference solution was deployed to a disposable AWS environment in
`ap-southeast-2` and exercised through the native AgentCore Memory Gateway
connector with three separately scoped Cognito access tokens.

| Check | Observed outcome |
| --- | --- |
| Gateway authentication and authorization | PASS: `CUSTOM_JWT`, Policy `ENFORCE`, Gateway `READY` |
| Scoped event writes | PASS for Tenant A shopping, Tenant A support, and Tenant B shopping agents |
| Cross-tenant and cross-session writes | PASS: denied by Cedar |
| Caller-supplied extraction override | PASS: denied by Cedar |
| Exact tenant namespace retrieval | PASS for both tenants |
| Two agents sharing Tenant A long-term memory | PASS: both returned the same Tenant A record |
| Tenant B isolation | PASS: Tenant B returned only its own record; no A canary appeared |
| Changed namespace paths | PASS: Tenant B, tenant root, and actor root paths denied |
| Actor enumeration and record-ID access | PASS: denied by default |
| Direct IAM call to Memory | PASS: denied by the Memory resource policy |
| Direct assumption of the Gateway role | PASS: denied by the service-only trust policy |
| New semantic extraction in the final run | PASS: both tenant canaries became retrievable through Gateway |
| Live authorization and isolation assertions | 20 passed; the optional expired-token fixture was not run |
| `npm test` | 30 Cedar evaluation cases passed |
| Python unit tests | 32 passed |
| `npm audit --omit=dev --audit-level=high` | No reported vulnerabilities |
| Bandit source scan | No medium- or high-severity findings |

The live run found two details that materially changed the sample.

First, the Memory resource fence must use the dedicated Gateway execution role's
`aws:PrincipalArn`. A fence based on the Gateway `aws:SourceArn` produced an
explicit resource-policy deny because that source key was not present when the
native connector called Memory.

Second, the deployed native connector supplied `context.input` for `ListEvents`
but did not supply its path `actorId` or `sessionId`, despite the current
[Memory FGAC reference](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-gateway-fgac.html)
listing path parameters as request context. A permit could therefore be scoped
to the operation, but not safely to the tenant. The reference solution denies
short-term event reads and deletion to agent callers. It exposes only
`CreateEvent`, `RetrieveMemoryRecords`, and `ListMemoryRecords`, whose tenant
fields were present and verified live.

The final fresh deployment passed every scoped allow and deny case. Its
newly submitted events produced separate long-term records: both Tenant A
agents recalled Tenant A's canary, while Tenant B recalled only its own. An
earlier run timed out while waiting for repeated synthetic facts, which can be
merged or deduplicated by the semantic strategy. Use a fresh Memory when
measuring extraction latency.

Signed tokens, resource identifiers, and raw diagnostics remain in ignored local
files. The disposable service resources and their permissions were removed
after validation. The two IAM roles were emptied of permissions and recorded
for later deletion.
