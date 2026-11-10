# Agentic AI Acceleration Patterns

A collection of samples, best practices, and reference architectures to
accelerate the building of Agentic AI applications on AWS.

Each sample demonstrates one pattern and is built as a building block: a
sample can consume other samples through their published interface (an
exported CDK construct and published SSM parameters), and later samples can
consume it. How the samples fit together (tenant identity, tenant isolation,
the control plane) is in [the Architecture Overview](./ARCHITECTURE.md).
Alongside the code,
every sample ships its design trail: an `architecture.md` describing the
implemented state, an ADR file recording the decisions and their reasoning,
and a `design/` folder holding the working specification the sample was built
from — read those to understand *why* the sample looks the way it does, not
just *what* it does.

What every sample ships, and the bar it meets before it is merged, is
described in [the Sample Standard](./docs/sample-standard.md).

## Contents

- [Architecture Overview](./ARCHITECTURE.md)
- [Samples](#samples)
  - [The Cell-Based Control Plane](#the-cell-based-control-plane)
  - [Tenant Identity with Amazon Cognito](#tenant-identity-with-amazon-cognito)
  - [Agentic runtime isolation: the agent platform at scale](#agentic-runtime-isolation-the-agent-platform-at-scale)
  - [Per-Tenant Encrypted Ingestion for Agentic Applications](#per-tenant-encrypted-ingestion-for-agentic-applications)
- [Contributing a sample](#contributing-a-sample)
- [Further Reading](#further-reading)
- [Costs](#costs)
- [Security](#security)
- [License](#license)

## Samples

| Sample | Description |
|---|---|
| [The Cell-Based Control Plane](./samples/control-plane/) | A control plane that onboards tenants into cells across either the vendor's or the customer's AWS accounts. Cells hold one to many tenants, with `maxTenants: 1` yielding dedicated tenant cells. Vendor accounts hold one to many cells and scale to a new account when the cell limit is reached. |
| [Tenant Identity with Amazon Cognito](./samples/tenant-identity/) | An identity layer that makes Amazon Cognito the trusted source of tenant identity, in three user-pool topologies chosen at deploy time — plus a `tiered` mode that runs two of them side by side — with RFC 8693 token narrowing to one tenant. |
| [Agentic runtime isolation: the agent platform at scale](./samples/agentic-runtime-isolation/) | A pooled agent platform on Amazon Bedrock AgentCore: one ingress verifies the tenant token, resolves the agent and tool grant from an entitlement store, mints a 5-minute transaction token and invokes the agent's Runtime (a fresh microVM session per request by default, one per tenant or per user with session mapping) with tenant-scoped credentials, while a tools gateway (one by default, more optional) checks each call with a per-tool interceptor and then AgentCore Policy. With `agentDelegation` on the `api-gateway` ingress, an agent hands the transaction to another agent through that ingress, which re-issues the token for the next hop. |
| [Per-Tenant Encrypted Ingestion for Agentic Applications](./samples/tenant-encrypted-ingestion/) | One drop zone and pipeline for every tenant's documents, each tenant's encrypted with its own AWS KMS key, kept apart by key policy and identity-policy ABAC rather than code, validated by a deployer-extensible chain before it lands, in a vendor-owned or tenant-owned key tier, with cryptographic offboarding. |

## The Cell-Based Control Plane

A control plane that onboards tenants into cells across either the vendor's
or the customer's AWS accounts.

A cell is one shared application deployment plus up to `maxTenants` tenants,
each with its own per-tenant deployment inside the cell. `maxTenants: 1`
yields dedicated tenant cells.

Accounts are registered through the API. A vendor account holds one to many
cells up to a cell limit; when every vendor account is full, the fleet moves
on to the next registered one. A customer account receives only the tenants
that name it. Each account is reached through a role pair installed in that
account, which the account owner can revoke. The control plane stores no
credentials for any account.

`POST /tenants` places the tenant in an existing cell or creates a new cell
in an eligible account, then runs your provisioning scripts in AWS CodeBuild
under that account's provisioning role through a Step Functions workflow:
the cell create script first when a new cell is needed, then the tenant
create script. Scripts are fixed at deployment time by a CellDefinition;
callers cannot supply code. Every API operation requires a JWT from your
vendor IdP, validated by a Lambda Authorizer.

[The Cell-Based Control Plane](./samples/control-plane/)

## Tenant Identity with Amazon Cognito

Every multi-tenant application has to answer one question on every request:
which tenant is this caller acting for? Amazon Cognito proves who a user is,
but it has no notion of a tenant. The alternative — keeping a user-to-tenant
mapping in an application table and consulting it on every request — puts a
second source of truth on the request path that can drift from the directory.

This sample overlays tenant identity onto Cognito so the tenant rides in every
access token as a claim Cognito signs, and a service reads it from a verifiable
claim instead of a lookup. It builds the three overlays Cognito allows — one
pool per tenant, an immutable user attribute, or a group — side by side behind
one platform API and one token contract, chosen once at deploy time, and adds a
fourth `tiered` deployment mode that runs the pool-per-tenant and shared-pool
overlays together in one stack, with each tenant placed in a `standard` or
`premium` tier at onboarding. The vendor
manages tenants and users with IAM through `/platform/*`; a tenant admin manages
its own tenant's users through `/tenant/*`. Because a token can name every
tenant a user belongs to, a client trades a refresh token at an RFC 8693
exchange endpoint for an access token narrowed to one tenant, which Cognito
re-signs so it verifies the same way.

The sample stops at the token: verifying it and scoping a request belongs to
the consuming service, which is an extension seam rather than built here. See
[Tenant Identity with Amazon Cognito](./samples/tenant-identity/).

## Agentic runtime isolation: the agent platform at scale

Building an agent platform for a scale of 10,000s of tenants and agents and
1,000s of tools introduces challenges which are not present at lower
volumes. Enforcing least-privilege isolation and per-tenant and per-user
entitlements goes beyond the limits of what OAuth scopes can handle: a scope
list in the identity token must name every tool the user may use with any
agent, grows past the token size caps of the identity provider, and changes
only at the next sign-in.

This sample describes a reference architecture in which one shared ingress
is the only code that sees the identity token. It computes each agent's
grant per request from an entitlement store (what the agent needs, what the
tenant bought, what the tenant admin cut), mints a short-lived transaction
token bound to that one agent and its tools gateways, and invokes the agent
in its own AgentCore Runtime microVM with tenant-scoped credentials. Tools
gateways and tools trust that token and a signed per-call context, never
the agent. An agent can also hand a transaction to another agent through
the same ingress, which re-issues the token for the next hop with the
caller recorded in `act`. Entitlement cardinality lives in data, not in
policies or roles, so the design lets you scale to 10,000s of tenants, each
with 1,000s of agents and 1,000s of tools, while a cut or a subscription
change takes effect on the next request and every hop holds the narrowest
token that works.

It consumes `tenant-identity` (`shared-pool`) and ships as CDK constructs
that later samples can consume (`SharedIngress`, `AgentBackend`,
`ToolTarget`, `TokenSigner`, `EntitlementStore`); the ingress publishes its
interface as one JSON parameter. See
[Agentic runtime isolation: the agent platform at scale](./samples/agentic-runtime-isolation/).

## Per-Tenant Encrypted Ingestion for Agentic Applications

Agentic applications are fed with tenant documents, the most sensitive data
they hold, and every tenant shares one drop zone and one pipeline. One
tenant's documents must never be readable with another tenant's key or by
code acting for another tenant, a tenant must be able to leave with its
documents made unreadable, and each deployment needs its own admission
checks without giving them broad access.

This sample gives every tenant its own AWS KMS key and makes KMS and IAM
enforce the separation: the key policy binds each key to the tenant's S3
prefixes and the pipeline's tenant roles, and those roles' own identity
policies scope every call by a `TenantId` session tag, so a wrong-tenant bug
is refused by AWS. A tenant user uploads to a presigned, write-once URL that
fixes the tenant's key; the pipeline runs structural checks and then the
deployer's validator chain under a tenant session, and only then lands the
document and publishes `DeliveryAccepted`. The key is the vendor's
(`vendor-key`) or lives in the tenant's own account (`tenant-key`), where the
tenant can withdraw it and the pipeline fails closed; offboarding schedules
the key for deletion.

It ships as one CDK construct, `TenantEncryptedIngestion`. Its demo stack,
integration test and demo use tenant-identity's `shared-pool`; the construct
accepts any OIDC issuer that meets the token contract. See
[Per-Tenant Encrypted Ingestion for Agentic Applications](./samples/tenant-encrypted-ingestion/).

## Contributing a sample

New samples follow [the Sample Standard](./docs/sample-standard.md): the
directory layout, the design trail (specification, ADRs, threat model,
architecture), the diagram conventions, the code and test requirements, the
security review, and the README structure. Section 9 of the standard is the
definition of done a pull request is reviewed against. General contribution
guidelines are in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Further Reading

Blogs and articles on multi-tenant agentic, written by AWS authors.

### AWS Blogs

- [Building multi-tenant agents with Amazon Bedrock AgentCore](https://aws.amazon.com/blogs/machine-learning/building-multi-tenant-agents-with-amazon-bedrock-agentcore/) —
  part 1 of a series: ten design considerations for multi-tenant agents, and
  the silo, pool, and bridge deployment models with Amazon Bedrock AgentCore.
- [Shared infrastructure, isolated tenants: Pool model multi-tenancy with Amazon Bedrock AgentCore](https://aws.amazon.com/blogs/machine-learning/shared-infrastructure-isolated-tenants-pool-model-multi-tenancy-with-amazon-bedrock-agentcore/) —
  part 2: a working pool-model implementation with tenant-scoped credentials
  (token vending machine + ABAC), service tiers, Cedar policies, and
  per-tenant cost attribution.
- [Apply fine-grained access control with Bedrock AgentCore Gateway interceptors](https://aws.amazon.com/blogs/machine-learning/apply-fine-grained-access-control-with-bedrock-agentcore-gateway-interceptors/) —
  per-principal access control for MCP tools at the gateway layer.
- [Implementing tenant isolation using Agents for Amazon Bedrock in a multi-tenant environment](https://aws.amazon.com/blogs/machine-learning/implementing-tenant-isolation-using-agents-for-amazon-bedrock-in-a-multi-tenant-environment/) —
  tenant isolation patterns for Bedrock Agents using dynamically scoped
  credentials.
- [Multi-tenant RAG with Amazon Bedrock Knowledge Bases](https://aws.amazon.com/blogs/machine-learning/multi-tenant-rag-with-amazon-bedrock-knowledge-bases/) —
  silo, pool, and bridge patterns for the retrieval layer of agentic
  applications.
- [Multi-tenancy in RAG applications in a single Amazon Bedrock knowledge base with metadata filtering](https://aws.amazon.com/blogs/machine-learning/multi-tenancy-in-rag-applications-in-a-single-amazon-bedrock-knowledge-base-with-metadata-filtering/) —
  metadata-based tenant isolation within a shared knowledge base.

### AWS Builder Center

- [Building multi-tenant agents on AWS](https://builder.aws.com/content/2v91CARGir2sm1Bh5jyFw6kDEge/building-multi-tenant-agents-on-aws)
- [Secure shared multi-tenant agent memory namespaces using AgentCore Memory](https://builder.aws.com/content/3C1SCSoe15VaBnmsiMIfGcZfhxM/secure-shared-multi-tenant-agent-memory-namespaces-using-agentcore-memory)
- [Secrets of Agentic Scale (SAS): The patterns towards 10,000 tenants](https://builder.aws.com/content/3HAuf5WXy0quw5cet8SBSCiMemF/secrets-of-agentic-scale-sas-the-patterns-towards-10000-tenants) —
  a six-part series on the distributed-systems problems that surface between
  100 and 10,000 tenants on an agent platform:
  - [SAS01 Capacity: Your agent platform scales in sessions, not requests](https://builder.aws.com/content/3HAzCi29WiO6QVYskY5RYh5FIFt/sas01-capacity-your-agent-platform-scales-in-sessions-not-requests)
  - [SAS02 Fairness: Admit on a forecast, reconcile on actuals](https://builder.aws.com/content/3HB21wIwHVIVH3c9BkcRGVC3sXR/sas02-fairness-admit-on-a-forecast-reconcile-on-actuals)
  - [SAS03 Park, don't shed: Graceful degradation for long-running agents](https://builder.aws.com/content/3HB7ctfd7QhqPKckp8xVEpc6ktQ/sas03-park-dont-shed-graceful-degradation-for-long-running-agents)
  - [SAS04 Your prompt store is a control plane](https://builder.aws.com/content/3HB9f0Exn8mfxZ4iLEC11S1Dg8v/sas04-your-prompt-store-is-a-control-plane)
  - [SAS05 A bad prompt is a bad deploy](https://builder.aws.com/content/3HBAZDLIQqvP8GG9HBB5obIhlyo/sas05-a-bad-prompt-is-a-bad-deploy)
- [Agentic AI delegation patterns](https://builder.aws.com/content/3HBLL1UuIpyzPENldeTfjYjvGQj/agentic-ai-delegation-patterns)

## Costs

Deploying a sample creates billable AWS resources in your account. Each
sample's README documents how to exercise it and how to tear it down —
delete the sample's stacks when you are done.

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file.
