<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0001: Use issuer-scoped claims with the native Memory connector

- Status: Proposed
- Date: 2026-10-21
- Deciders: Pending technical review

## Context

Several agents in one tenant need shared facts while sessions remain private.
The application authenticates callers with OAuth tokens. The shopping and
support agents in Tenant A share `/tenants/tenant-a/shared/` but have different
write-session entitlements. Tenant B uses a separate actor and namespace.

A token vending service exchanges a verified identity for scoped downstream
credentials. Cedar evaluates whether an authenticated principal may perform an
operation with the supplied input. Credential issuance and request authorization
can be combined, but issued credentials enforce a boundary only when the
downstream caller uses them.

## Options considered

### Option 1: Upstream token vending with caller IAM credentials

**Documented connector alternative; not implemented in this sample.**

A trusted broker derives tenant, actor, session, and recall entitlement from
verified membership, then issues temporary STS credentials before the caller
signs its Gateway request with SigV4. Configure inbound `AWS_IAM` and outbound
`CALLER_IAM_CREDENTIALS`. The native connector forwards the caller's IAM
identity, so Memory evaluates that identity's effective permissions.

Use this path when workloads already use IAM federation or require downstream
IAM attribution. Session tags carry attributes for IAM conditions; session
policies narrow the assumed role's permissions. The broker must control role
selection, `sts:TagSession`, allowed tag values, and session-policy scope.
Gateway can retain Cedar for operation and payload constraints.

The connector also supports `AUTHENTICATE_ONLY` with caller credentials.
Prefer `AWS_IAM` when Cedar rules require the typed `AgentCore::IamEntity`
principal. This path requires a Memory-specific implementation and isolation
tests; forwarding caller identity alone does not establish tenant authorization.

### Option 2: Native Memory connector and JWT-aware Cedar

**Implemented reference solution.**

Gateway validates issuer-scoped JWTs with `CUSTOM_JWT`. Cedar compares the
requested actor, session, or full namespace path with the trusted claims before
the native connector calls Memory.

For the native Memory connector, `CUSTOM_JWT` supports only
`GATEWAY_IAM_ROLE`; combining it with `CALLER_IAM_CREDENTIALS` is rejected.
Memory therefore sees the dedicated Gateway execution role. OAuth claims
appear as tags on Cedar's `AgentCore::OAuthUser` principal. They are distinct
from STS session tags evaluated through IAM's `aws:PrincipalTag`, and do not
become tags on the Gateway execution role.

This fits an OAuth application using the managed Memory connector. Cedar
enforces tenant request scope; the role permissions and Memory resource policy
restrict the shared downstream identity and direct access.

### Option 3: Gateway interceptor vending to a custom target

**Published MCP pattern; a Memory adaptation is not implemented here.**

A request interceptor can resolve entitlements and issue temporary credentials.
A custom MCP server or adapter must explicitly consume those credentials when
constructing its Memory SDK client. Adding STS credentials to interceptor
output does not replace the native connector's configured signing identity.

Use this path when a custom tool needs credential exchange, external entitlement
lookups, or an integration the native connector does not provide. The trusted
component must overwrite reserved identity context rather than accept caller
claims of authority. The target must reject missing or invalid scoped
credentials and avoid fallback to its own broader execution-role credentials.
Keep credentials out of model-visible arguments, responses, logs, and traces.

### Optional hybrid: Resolve attributes, then authorize with Cedar

An interceptor can retrieve a current entitlement while Cedar evaluates the
resulting trusted attributes and requested operation. The published MCP pattern
runs the request interceptor before Cedar and then invokes the target. STS
credentials issued by that interceptor can exist even when Cedar later denies
the request. Vending inside an authorized custom target is another design
option.

Native Memory interceptor support and transformed policy inputs need separate
validation. HTTP and MCP interceptor contracts differ; arbitrary MCP context
fields cannot be copied into a native Memory request body. Verify target
compatibility, the Memory input schema, and which transformed fields Policy
evaluates before implementing this extension. The current issuer claims already
provide the demonstrated scopes, so an interceptor adds no required entitlement
lookup to option 2.

## Decision

Implement option 2. Use a tenant actor for deliberately shared organisational
facts, one issuer-scoped session per agent conversation, exact namespace claims,
default deny, and `ENFORCE`. Permit only `CreateEvent`,
`RetrieveMemoryRecords`, and `ListMemoryRecords`. Reject caller-supplied
extraction overrides.

Keep the upstream IAM, custom-target, and hybrid paths as documented design
alternatives. The sample's Cognito claim-producing Lambda is an issuer
component, not a Gateway interceptor or STS token vending service.

## Consequences

Agents share selected facts while their permitted event writes remain scoped
to separate sessions. Stored event reads and deletion are outside the
agent-facing API. Private user facts require separate actors and namespace
entitlements regardless of the credential path.

The issuer owns membership and conversation assignment; Cedar owns request
authorization for the implemented path. Changing to caller or vended IAM
credentials requires adapting the current resource-policy fence, which allows
only the Gateway execution role. Evaluate role, session, and resource policies
together: a resource grant directly to a role-session ARN can add permissions
outside the session policy's implicit limits. Explicit denies take precedence.

JWT claims, STS credentials, and cached entitlements have lifetimes. Any vending
extension must manage expiry, renewal, retries, and entitlement changes without
promising immediate revocation of already-issued credentials. Scope credential
and client caches by tenant, actor/session, and entitlement. A tenant-only cache
could reuse the shopping agent's write permission for the support agent.

## References

- [Native Memory connector credential compatibility](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-gateway-connector.html)
- [Memory OAuth authentication and claim-based authorization](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-gateway-oauth.html)
- [Policy principal types](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-core-concepts.html)
- [Policy and Lambda interceptor design patterns](https://aws.amazon.com/blogs/machine-learning/secure-ai-agents-with-policy-and-lambda-interceptors-in-amazon-bedrock-agentcore-gateway/)
- [HTTP and MCP interceptor contracts](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-interceptors-types.html)
- [STS session tags](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_session-tags.html)
- [IAM session policies and resource-based grants](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies.html#policies_session)
