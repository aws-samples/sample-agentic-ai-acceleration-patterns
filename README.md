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
  - [The Simple Cell-Based Control Plane](#the-simple-cell-based-control-plane)
  - [Tenant Identity with Amazon Cognito](#tenant-identity-with-amazon-cognito)
- [Contributing a sample](#contributing-a-sample)
- [Further Reading](#further-reading)
- [Costs](#costs)
- [Security](#security)
- [License](#license)

## Samples

| Sample | Description |
|---|---|
| [The Simple Cell-Based Control Plane](./samples/control-plane/) | A minimal multi-tenant control plane for cell-based deployments — one service, one API, one DynamoDB table, one Step Functions workflow, script-driven provisioning via AWS CodeBuild. `maxTenants: 1` degenerates the model to a silo. |
| [Tenant Identity with Amazon Cognito](./samples/tenant-identity/) | An identity layer that makes Amazon Cognito the trusted source of tenant identity, in three user-pool topologies chosen at deploy time — plus a `tiered` mode that runs two of them side by side — with RFC 8693 token narrowing to one tenant. |

## The Simple Cell-Based Control Plane

A minimal multi-tenant control plane for cell-based deployments. A cell
is a deployment unit: one shared application deployment plus up to
`maxTenants` tenants, each with its own per-tenant deployment inside the
cell. Set `maxTenants: 1` and the model degenerates to a silo — one tenant
per cell.

Tenant onboarding is a single `POST /tenants` call: placement claims a slot
in an existing cell or creates a new cell implicitly, then a Step Functions
workflow runs your provisioning scripts in AWS CodeBuild — the cell create
script first when a new cell is needed, then the tenant create script.
Provisioning is defined once, at deployment time, by a CellDefinition; cells
are homogeneous by construction and callers can never supply code. Every API
operation requires a JWT from your vendor IdP, validated by a Lambda
Authorizer.

[The Simple Cell-Based Control Plane](./samples/control-plane/)

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
