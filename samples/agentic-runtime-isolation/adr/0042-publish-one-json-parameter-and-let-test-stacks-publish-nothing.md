<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0042: Publish one JSON parameter, and let test stacks publish nothing

- Status: Accepted
- Date: 2026-11-04
- Amends: ADR-0024
- Deciders: Dave Roberts (PSA)

## Context
AWS Systems Manager Parameter Store allows 3 `PutParameter` and 3 `DeleteParameter` calls per second per account and Region, and the quota is not adjustable; the paid higher-throughput setting raises it to 10 put and 5 delete ([Parameter Store throughput](https://docs.aws.amazon.com/systems-manager/latest/userguide/parameter-store-throughput.html)). `SharedIngress` published its interface as one `AWS::SSM::Parameter` per value (ADR-0024, spec §6.4): `endpointUrl`, `baseUrl`, `ingressRoleArn`, `ingressId`, `ingress`, `tenantRoleArn`, `gatewayIdentifier`, `issuer`, `jwksUrl`, `entitlementsTableName`, `entitlementsApiUrl`, `toolContextKeyId`, four values per tools gateway under `tools-gateways/<name>/`, and four pre-ADR-0041 aliases of the `default` gateway, plus the demo's `runtimeArn` and `backends-info/billing/runtimeArn`. That is 20 to 26 parameters a stack. The integration test deploys six stacks and destroys them together: on 2026-11-03, integration runs 6 to 8 left every stack `DELETE_FAILED` with `GeneralServiceException` on `DeleteParameter`. CloudFormation's own SSM handler retries a throttled call a few times and then gives up, and the registry-entry custom resource used the SDK's default retry, so a burst of six stacks in parallel exceeds what either absorbs.

## Options considered
### Option 1: Keep one parameter per value; destroy at concurrency 2
Pros: no interface change; the teardown retry already does this. Cons: a deploy of several stacks still bursts; a deployer's own pipeline that deploys stacks in parallel hits the same wall; it treats a design that costs 20 to 26 writes a stack as normal.

### Option 2: Trim to the values another stack needs at deploy time
About 7 values plus 4 per tools gateway, still read with `valueForStringParameter`. Pros: deploy-time resolution kept; fewer writes. Cons: still one write per value and per gateway, so 11 to 19 a stack with the demo's two gateways; consumers that need a dropped value (the JWKS URL, the entitlement API) lose it.

### Option 3: One JSON parameter; `fromParameters` becomes a synth-time lookup
`<registryPrefix>ingress` holds one versioned document with every value. CloudFormation cannot parse JSON at deploy time, so `SharedIngress.fromParameters` reads it at synth with `ssm.StringParameter.valueFromLookup`, as `Vpc.fromLookup` does. Pros: one write a stack whatever the number of gateways; the document is versioned and self-describing; a reader gets every value at once. Cons: consumers need AWS credentials at synth and a cached `cdk.context.json`; a value read at synth is stale until the context is reset.

### Option 4: Test stacks publish nothing
`SharedIngressProps.publish: false` (and the demo's `publishInterface: false`) writes no published parameter; the integration driver reads stack outputs. Pros: the six integ stacks write no fixed-name parameter at all. Cons: a test stack cannot exercise `fromParameters` against itself.

## Decision
Options 3 and 4 together, plus adaptive retry in the custom resources. `SharedIngress` publishes exactly one parameter, `<registryPrefix>ingress`, `Intelligent-Tiering` (standard up to 4 KB, advanced up to 8 KB), whose value is the `PublishedIngress` document: `version: 2`, `ingress`, `endpointUrl`, `baseUrl`, `ingressRoleArn`, `ingressId`, `tenantRoleArn`, `gatewayIdentifier` (agentcore-gateway only), `issuer`, `jwksUrl`, `entitlementsTableName`, `entitlementsApiUrl`, `toolContextKeyId` (with a tools gateway) and `toolsGateways: { <name>: { url, identifier, roleArn, policyEngineId } }`. The pre-ADR-0041 aliases and the demo's Runtime ARN parameters go; the Runtime ARNs are stack outputs. `fromParameters` keeps its signature (`ingress` becomes optional and, when given, must match the document), refuses a document whose `version` is not 2 or a gateway name the document lacks, and returns placeholder values on the first synth before the context provider has run. `publish: false` is the default for integration stacks. The registry-entry custom resource builds its SSM client with `retryMode: 'adaptive', maxAttempts: 8`.

## Consequences
Easier: a stack costs one Parameter Store write to deploy and one to destroy, so several stacks deploy and destroy together within the quota; a consumer gets every published value, including the JWKS and entitlement API URLs, with one read. Harder: a stack that calls `fromParameters` needs `env: { account, region }` and AWS credentials for that account at synth, and the value is cached in `cdk.context.json` (commit it, as with `Vpc.fromLookup`); after the ingress is replaced or its values change, run `cdk context --reset ssm:account=<account>:parameterName=<registryPrefix>ingress:region=<region>`. The document's 8 KB advanced-tier ceiling holds roughly 15 to 20 tools gateways; past that it would need splitting. The construct id of the one parameter stays `IngressParameter`, so updating a stack from the per-value layout rewrites `<prefix>ingress` in place instead of replacing it under its own fixed name. The registry rows stay one parameter per resource (`backends/<name>` from `RegistryEntryResource`, `tools/<target>` from `ToolTarget`), because the ingress resolves them at request time and each is owned by a different stack. ADR-0024's list of published parameters is superseded for the published interface. The integration driver reads stack outputs, and `demo.sh` and `perf.sh` read the document with `jq`. Revisit if Parameter Store raises the quota, if CloudFormation gains a JSON parse intrinsic, or if a consumer cannot synthesise with credentials.

**2026-11-04.** Amended by the security review: `fromParameters` validates the document before use (`publishedIngressProblem`): every URL is `https://`, every role ARN is an IAM role in the consuming stack's own account, identifiers and key ids match `[A-Za-z0-9_-]{1,128}`, the table name is a DynamoDB table name. The values land in the Runtime resource policy, tool function resource policies and Cedar text, so a substituted or mistyped document fails synth instead of being trusted.
