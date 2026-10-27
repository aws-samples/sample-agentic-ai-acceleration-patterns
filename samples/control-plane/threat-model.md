# Control Plane — Threat Model

> Status: **Reconstructed 2026-10-11.** The sample was built against a threat
> model kept outside the repository (`.threatmodel/threat_model.md`), which
> was never committed. This file records the threats and mitigations the
> sample itself cites in its README, ADRs, code comments, and tests, under
> their original identifiers so those citations stay valid. Identifiers not
> cited anywhere in the sample (T3–T4, T6–T8, T11–T12, T14–T15, T17–T19,
> M1–M8, M14, M16) are not reproduced; the numbering gaps are deliberate.
> New threats and mitigations continue the sequence (T21, M18).

Scope: the control plane's API edge, its identity model, the provisioning
path into CodeBuild, and the operational data it emits. The application plane
a CellDefinition provisions is out of scope here, except where the control
plane's choices bound its blast radius.

## Threats

| ID | Threat | Consequence | Status | Mitigations |
|---|---|---|---|---|
| T1 | Stolen operator token | Full admin over the tenant fleet for the token's remaining lifetime plus the authorizer cache window | Mitigated in code; residual bounded by the issuer's token lifetime (operational) | M9, M11, M13, M17 |
| T2 | Issuer misconfiguration: `vendorIdpIssuerUrl` / `vendorIdpAudience` point at a general workforce or customer issuer | Every member of that population is a control-plane admin | Mitigated in code (fail-closed role gate) and operationally (dedicated issuer) | M9, M13 |
| T5 | Poisoned provisioning source: a malicious commit on the ref the fleet builds from | Arbitrary code execution across the fleet under the CodeBuild roles on the next lifecycle operation. **Highest-consequence item.** | Partially mitigated: the sample can express an immutable pin but warns rather than refuses an unpinned ref; the rest is operational | M10 |
| T9 | Destructive API operations not attributable to an operator | No audit trail from an access-log line to a person | Mitigated in code | M12 |
| T10 | Application-plane changes made by provisioning scripts attributed only to the shared fleet CodeBuild roles | No link from an application-plane change back to the initiating API call | Mitigated in code | M12 |
| T13 | Log exposure: build logs readable by anyone with log-group access, scripts echoing fetched values, service-created log groups that never expire | Build logs become an unintended secrets store with unbounded retention | Mitigated in code and by script conventions | M15 |
| T16 | Cost and concurrency amplification: each `CreateTenant` can create a cell and run up to two hour-long builds | A leaked token or runaway client drives CodeBuild cost and exhausts concurrency | Mitigated in code (caps, throttling, alarms); tighter per-method limits are operational | M11, M17 |
| T20 | Issuer scope creep: gradual client or audience reuse on the dedicated issuer | Silent widening of the admin population without any configuration change on the control plane | Mitigated in code (role gate) and operationally (client review) | M9, M13 |
| T21 | Over-broad deployer-supplied policy on the tenant build role: `tenantBuildManagedPolicyArns` attaches a managed policy wider than the tenant scripts need | The shared tenant build role, which runs every tenant's script, gains that reach, so a compromised source or a bad script acts with it across the fleet | Mitigated in code (synth-time ARN validation) and by deployer responsibility (attach only least-privilege policies the producer publishes) | M18 |

## Mitigations

Each mitigation names where it lives. "Operational" items are the deployer's
responsibility and appear in the README's production hardening checklist.

| ID | Mitigation | Where | Threats |
|---|---|---|---|
| M9 | Identity hardening: dedicated control-plane issuer, deployment-time verification of issuer and audience, short-lived tokens, MFA for operators, periodic review of client registrations | Operational: README "Production hardening checklist", Identity (M9) | T1, T2, T20 |
| M10 | Supply-chain pinning: `SourceDefinition.sourceVersion` pins the provisioning source to a full 40-character commit SHA, stamped into every build as the CodeBuild `SourceVersion` override; synthesis warns when the ref is absent or mutable. Branch protection, signed commits, read-only deploy credentials, and treating a CellDefinition change as a release are operational | [ADR-020](./adr/0020-supply-chain-pinning-warn-and-allow.md); `src/main.ts`, `src/shared/service-config.ts`, `src/tenant/tenant.sfn.ts`; `test/main.test.ts` (pin validation, SourceVersion pass-through); README, Supply-chain hardening (M10) | T5 |
| M11 | Edge protection: stage-wide throttling (20 rps rate, 40 burst) in the sample; AWS WAF web ACL, per-method usage plans, and a source-IP resource policy are operational | `src/tenant/tenant.cdk.ts` (stage throttling); README, Edge protection (M11); cdk-nag suppression on WAF association with reason | T1, T16 |
| M12 | Operator identity end-to-end: the verified JWT `sub` is the authorizer principal, appears in API Gateway access logs, rides the Step Functions execution input, and reaches every build as `OPERATOR_ID` | [ADR-019](./adr/0019-operator-identity-end-to-end.md); `src/tenant/tenant.cdk.ts` (access-log format), `src/tenant/tenant.ts`, `src/tenant/tenant.sfn.ts`; `test/main.test.ts` (access logging, OPERATOR_ID override) | T9, T10 |
| M13 | Role-claim enforcement: the authorizer requires the `role` claim to match a deployment-configured allowlist (`ALLOWED_ROLES`, default `operator`) and fails closed; authentication alone is not sufficient | [ADR-018](./adr/0018-enforce-role-claim.md) (amends [ADR-015](./adr/0015-authentication-only-gating.md)); `src/shared/authorizer.function.ts`, `src/shared/authorizer-policy.ts`, `src/tenant/tenant.cdk.ts`; `test/main.test.ts` (allowlist wiring) | T1, T2, T20 |
| M15 | Bounded log exposure: explicit log groups with one-month retention for the Lambda functions and both CodeBuild projects; provisioning scripts never use `set -x` and log names and status, not values | [ADR-021](./adr/0021-bounded-blast-radius.md); `src/tenant/tenant.cdk.ts`, `src/tenant/tenant.sfn.ts`; `scripts/CONVENTIONS.md`; `test/main.test.ts` (every log group has bounded retention) | T13 |
| M17 | Bounded amplification: `concurrentBuildLimit: 5` on both CodeBuild projects; CloudWatch alarms (no actions) on more than 20 provisioning executions or more than 50 4XX responses in five minutes; stage throttling as in M11 | [ADR-021](./adr/0021-bounded-blast-radius.md); `src/tenant/tenant.sfn.ts`, `src/tenant/tenant.cdk.ts`; `test/main.test.ts` (build caps, alarms) | T16 |
| M18 | Bounded managed-policy attachment: `tenantBuildManagedPolicyArns` is validated at synth to be managed-policy ARNs in the stack's own partition and account (AWS managed policies and other accounts rejected), and attached by reference only — the control plane never reads what a policy grants (P-3). Choosing a least-privilege policy is the deployer's responsibility; the producer publishes one (e.g. tenant-identity `PlatformInvokePolicy`, its ADR-0030) rather than the deployer hand-writing a grant | [ADR-022](./adr/0022-attach-deployer-supplied-managed-policies-to-the-tenant-build-role.md); `src/tenant/tenant.cdk.ts` (`validateTenantBuildManagedPolicyArns`, attachment), `src/main.ts`, `src/tenant/tenant.sfn.ts`; `test/main.test.ts` (ARN validation, attachment); README, Production hardening checklist | T21 |

Related design decisions without a mitigation number: role asymmetry between
the cell and tenant CodeBuild roles bounds what lifecycle scripts may write
(spec P-12, README "Security notes"); the 60-second authorizer result cache
(`model/__global.smithy`) bounds how long a revoked token keeps access (T1);
unsigned pagination tokens are harmless because queries are partition-pinned
([ADR-016](./adr/0016-unsigned-pagination-tokens.md)).

## Accepted findings

Static-analysis findings the sample accepts rather than fixes are recorded as
cdk-nag, cfn_nag, and checkov suppressions in `src/tenant/tenant.cdk.ts` and
`src/tenant/tenant.sfn.ts`, each with a reason. The recurring ones:

- WAF association on the REST API stage is a production deployment concern
  outside the sample (M11 lists it as operational).
- The API is not usage-plan or API-key based; callers authenticate with
  vendor-IdP JWTs through the Lambda Authorizer (cfn_nag W64, W68).
- Lambda reserved concurrency is not partitioned; API Gateway stage
  throttling bounds the invoke rate (cfn_nag W92, checkov CKV_AWS_115).

## Open items

- **T5 remains the highest-consequence open item.** The sample warns on an
  unpinned or mutable source ref instead of refusing it, so a deployer can
  still run the fleet from a branch. ADR-020 records why (an unpinned demo
  must keep working). A deployment that refuses mutable refs changes the
  `Annotations.addWarningV2` call in `src/main.ts` to `addError`.
- Alarms have no actions. Wiring them to a notification target is the
  deployer's choice of channel.
