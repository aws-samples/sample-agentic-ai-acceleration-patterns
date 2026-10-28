<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0024: Share one ingress across several Runtimes through a backend registry

- Status: Accepted
- Date: 2026-10-28 (accepted on the first green integration run; first proposed 2026-10-27)
- Deciders: Dave Roberts (PSA)

## Context
Before this decision the construct created one ingress and one backend
(ADR-0003, ADR-0011): the integration Lambda or the interceptor read one
`RI_RUNTIME_ARN`, and the Runtime's resource policy named that ingress role
alone (ADR-0001). A vendor
with several agents (a support agent, a billing agent) deploys the construct
once per agent and gets one API, one authoriser, one stage throttle, one
counter table and one log drain per agent. The token check, the TVM, the
tenant limit and the metering are identical across those copies; only the
Runtime differs. Tenants call several hostnames for one product.

Two requirements shape the shared form:

- **Scope-bound authorisation per backend.** Today `requiredScopes` is one
  list for the whole ingress (`RI_REQUIRED_SCOPES`, and `allowedScopes` on
  the Gateway authoriser, ADR-0005). Behind a shared ingress a token good
  for the product must not reach every backend; each backend names the
  scopes a token needs for it, and the ingress enforces that per route.
- **Backend CRUDL without ingress downtime.** Creating, changing or
  removing a backend must not redeploy the shared ingress. A redeploy of
  the one API, authoriser, Lambda and role is a change event for every
  backend at once, and it ties each backend team's release to the ingress
  owner's.

Constraints: P-1 (the backend trusts exactly one ingress) must hold for
every Runtime. The published interface (`endpointUrl`, `runtimeArn`, the
SSM parameters, standard §1.1) must not break for the single-agent deployer.
The AgentCore Gateway already addresses a target by URL
(`/<target>/invocations`, ADR-0010), so the shared shape must fit both
ingresses with the same client contract (spec §5).

## Options considered
### Option 1: Keep one construct per Runtime (status quo)
Pros: no change; the smallest blast radius, one ingress bug reaches one
Runtime; scopes and lifecycle are per backend by construction. Cons: N
copies of the identical ingress; N hostnames for one product; N counter
tables, so a tenant's limit is per agent and never per product; N stage
throttles that do not add up to a product-wide budget.

### Option 2: One ingress, a static route per Runtime (the first proposal)
`agents: Record<name, AgentProps>` on the construct; one API Gateway
resource per name, a name-to-ARN map in the Lambda environment, the ingress
role granted each Runtime ARN. Pros: an unknown route never reaches the
Lambda; nothing is looked up on the hot path. Cons: fails both
requirements. Every create, update or delete of a backend is a deploy of
the shared ingress (a new resource, a new environment value, a new grant),
and the scope list stays ingress-wide, so one token reaches every backend.

### Option 3: One ingress, the tenant table picks the Runtime
The route stays `/invocations`; a tenant attribute (tier, silo) names the
Runtime. Pros: fits tiered or silo tenants. Cons: the construct would need a
tenant store it does not have today (spec §4: no stored entities); a tenant
sees one agent, which does not answer the several-agents case; a lookup per
request on the hot path before the Runtime call.

### Option 4: Share the REST API only, one integration Lambda per route
Pros: per-route reserved concurrency, so agents cannot starve each other;
each Lambda keeps one `RI_RUNTIME_ARN` and the P-1 shape per Lambda role.
Cons: N Lambdas, N log drains and N TVM caches behind one API; still an
ingress deploy per backend; does not exist on `agentcore-gateway`, where
the interceptor is one function per Gateway.

### Option 5: One ingress, one path parameter, a backend registry
The ingress serves `POST /{backend}/invocations` through one API Gateway
resource (one Gateway, on `agentcore-gateway`). A registry outside the
ingress deploy maps each backend name to `{ runtimeArn, requiredScopes,
status }`; the ingress reads it with a short cache and the backend's own
stack writes it. Pros: meets both requirements; one hostname, one token
path, one tenant limit and one log line per product; the registry is the
published interface the sample already has (SSM under
`/application-plane/shared/agent-runtime/`, standard §1.1). Cons: a lookup
and a cache on the hot path; an unknown name reaches the authoriser instead
of being refused by API Gateway; the ingress role's grant must cover
Runtimes that do not exist at its deploy, so it becomes a pattern plus a
condition rather than a list; the registry is a new trust boundary.

## Decision
Option 5, verified by implementation (integration run 2026-10-28, eu-central-1,
both ingresses, step 9-registry green).

**Shape.** `SharedIngress` is the ingress alone: API or Gateway, authoriser,
TVM, limits, log drain, and the registry prefix it reads. `AgentBackend`
(one per backend, in its own stack if the deployer wants) creates the
Runtime, sets the Runtime's resource policy to the ingress role it reads
from the ingress's published parameters (P-1 per Runtime, ADR-0001), writes
its registry entry, and on `agentcore-gateway` creates its Gateway target.
The one-backend form is a `SharedIngress` with a `defaultBackend` plus one
`AgentBackend` of that name, so today's bare `/invocations` URL and published
values do not change; no separate wrapper construct is kept.

**Route.** `POST /{backend}/invocations` on both ingresses. The name is
`[a-z0-9-]{1,32}`. The authoriser looks the name up; an unknown or
`draining` name is refused (404) before the body is read.

**Registry.** SSM Parameter Store,
`/application-plane/shared/agent-runtime/backends/<name>`, a JSON string
`{ "runtimeArn", "requiredScopes": [], "status": "active" | "draining" }`.
The ingress caches entries per process for 60 seconds (`registryTtl`), so a
write is live within one TTL and a cold instance pays one `GetParameter`.
Each backend role may `PutParameter` and `DeleteParameter` on its own name
only; the ingress role may read the prefix only.

**Scopes.** The ingress-wide `requiredScopes` stays as the product floor
(and as the Gateway authoriser's `allowedScopes`). On top, the authoriser
requires the route's `requiredScopes` from the registry; the API Gateway
authoriser result is cached per token and route, and the interceptor runs
the same check per Gateway target. Refusal: 403 (ADR-0005 order holds).

**Grant.** The ingress role's `InvokeAgentRuntime` grant is the Runtime
ARN pattern of the account and Region with a condition that the Runtime
carries the tag `ri:ingress = <ingress id>`, which `AgentBackend` sets. The
Runtime's resource policy remains the hard gate (ADR-0001). The Service
Authorization Reference (read 2026-10-28) lists `aws:ResourceTag/${TagKey}`
for `InvokeAgentRuntime` on both `runtime` and `runtime-endpoint`, so the
condition is honoured. The grant names two resources, `<arn>` and `<arn>/*`
(the endpoint), and the endpoint carries its own tags. Checked on
2026-10-28 in the sandbox (eu-central-1) against a deployed Runtime: tags
given at `CreateAgentRuntime` (the `CfnRuntime.tags` property) are copied to
the `DEFAULT` endpoint; a later `TagResource` on the Runtime is not, and the
endpoint ARN can be tagged on its own. So `AgentBackend` sets `ri:ingress`
in `CfnRuntime.tags` at synth and the grant holds for both resource forms.
A tag changed after creation must be put on both ARNs. Tested end-to-end
the same day: a role allowed `InvokeAgentRuntime` on `runtime/*` and
`runtime/*/runtime-endpoint/*` with `StringEquals aws:ResourceTag/ri:ingress`
reached a Runtime created with that tag (HTTP 200; the agent then refused for
want of the credential header, as expected) and was refused on an untagged
Runtime with `AccessDeniedException ... no identity-based policy allows`.
Integ step 9 repeats this against the deployed construct.

**CRUDL.** Create: Runtime, policy, target, then the registry entry; live
within one TTL. Read and list: `GetParameter`, `GetParametersByPath`.
Update: overwrite `runtimeArn`; the old Runtime serves streams already
running, new requests move within one TTL. Delete: set `draining`, wait one
TTL plus the longest stream (2 minutes on `api-gateway`), delete the
Runtime and target, remove the entry. No row redeploys the ingress.

## Consequences
Easier: one hostname and one bearer token path per product; one tenant
limit across all its backends (ADR-0020); one log line and one Contributor
Insights rule set with a `backend` field (ADR-0017, ADR-0021); a backend
team ships, changes and retires its Runtime on its own release train; a
token is good for the backends its scopes name and no other.

Harder: a registry lookup joins the hot path (cached; a miss costs one SSM
call, and SSM standard throughput is 40 TPS per account, so the cache is
not optional). The registry is a trust boundary: whoever writes
`backends/<name>` chooses which Runtime answers that route, so the write
grant is per backend role and per name, and the threat model gets the entry
(a wrong `runtimeArn` sends a tenant to the wrong backend, not to another
tenant's data: credentials and session prefix come from the verified claims
alone, ADR-0002, ADR-0012). The ingress role's grant is a pattern, not a
list, so the Runtime resource policy carries P-1 alone if the tag condition
is not honoured. On `api-gateway` the stage throttle and the one Lambda's
concurrency are shared by every backend, which the README must say next to
the existing 6,000-concurrent figure; Option 4 or one construct per backend
remains the answer when backends must not share concurrency. One `tvm.role`
serves every backend, so a backend cannot be given a narrower tenant role
than its siblings.

Harder, from the choice of SSM Parameter Store as the registry (reviewed
2026-10-28; SSM is kept because it is the sample's published-interface
pattern and the registry is small and slow-changing):

- *Quota.* 40 TPS standard per account and Region, shared by every SSM
  caller in the account; the higher tier is paid. The cache is the control:
  misses are instances × backends ÷ `registryTtl`, and a stale entry is
  served while a refresh runs.
- *Eventual consistency, no conditional write.* Two instances may disagree
  for one TTL, and two writers to one name are last-write-wins. One writer
  per name by IAM; the ingress logs the parameter version it resolved.
- *No transactions.* Runtime, resource policy, Gateway target and registry
  entry are four writes; a failed create leaves a half backend. The entry is
  written last and `status` gates traffic.
- *Untyped value.* A JSON string, schema by convention, 4 KB on the standard
  tier; a bad entry fails at request time. `AgentBackend` validates at
  synth; the ingress answers 502 and logs the fault.
- *Availability dependency.* With SSM unavailable, warm instances serve the
  stale cache and cold instances resolve nothing, so the ingress fails
  closed for new instances.
- *Cross-account.* A standard parameter cannot be shared; an advanced
  parameter shares through RAM read-only. A backend in another account
  needs a registrar role in the ingress account, or a different store.
- *Hidden dependency.* `AgentBackend` reads `ingressRoleArn` by parameter
  name, so CloudFormation sees no dependency between the stacks. Deploy
  order is documented and scripted; deleting the ingress leaves entries,
  and its stack removes the prefix on delete.
- *Drain on delete.* An `AWS::SSM::Parameter` disappears at once on stack
  delete, so `draining` needs a custom resource that writes the status,
  waits one TTL plus the longest stream, then removes the entry (the log
  drain shape, ADR-0019).
- *Fixed prefix.* `/application-plane/shared/agent-runtime/` is one per
  account and Region, so two ingresses in one account collide. `SharedIngress`
  takes a `registryPrefix` prop; a `SharedIngress` with `defaultBackend` keeps
  the default.
- *Counts and listing.* 10,000 standard parameters per account and Region,
  shared with everything else; `GetParametersByPath` returns 10 per call.
  Fine for hundreds of backends, not thousands.
- *No push.* The ingress learns of a change through the cache TTL, not an
  event.

What implementation changed in the text above (verified on the 2026-10-28
integration run):

- *Create refuses an existing name.* The registry custom resource writes
  with `Overwrite: false`, so a second stack claiming a name fails its
  deploy instead of silently taking the route; two writers to one name are
  no longer last-write-wins on Create (Update still overwrites). An existing
  entry whose `runtimeArn` is already this Runtime's is reclaimed, so a
  retried Create (a lost CloudFormation answer, a rolled-back stack) is not
  mistaken for a duplicate.
- *Delete drains only its own entry.* The custom resource sets `draining`
  and removes the parameter only when the entry's `runtimeArn` is the one
  it wrote; an entry another writer replaced is left alone.
- *`registryTtl` is bounded* to 1 s to 750 s at synth.
- *Cross-stack by `fromParameters` only.* An `AgentBackend` in another
  stack takes `SharedIngress.fromParameters(scope, id, prefix, ingress)`;
  passing a `SharedIngress` instance from another stack fails synth, so the
  "hidden dependency" above is the only cross-stack shape.
- *No default backend on `agentcore-gateway`.* The Gateway routes by
  target, so the name is always in the path there; `defaultBackend` applies
  to the bare `/invocations` route on `api-gateway` only. A stage-prefixed
  path is not accepted on either ingress.
- *Account and Region check.* The ingress accepts an entry only when its
  `runtimeArn` is in the ingress's own partition, Region and account
  (`RI_REGISTRY_ACCOUNT`); a foreign ARN is 502. This bounds the "wrong
  `runtimeArn`" consequence to Runtimes the ingress could invoke anyway.
- *Bounded staleness.* The cache backs off after a failed refresh and
  serves a stale entry for at most ten times `registryTtl`, after which the
  route answers 502 `registry_unavailable`; "warm instances serve the stale
  cache" above holds for that window only.
- *Resource policy names the Runtime ARN alone.* `PutResourcePolicy` accepts
  exactly one `Resource` per statement, equal to the attached ARN; `<arn>/*`
  is refused (ValidationException, 2026-10-28). The ingress invokes by Runtime
  ARN, so the policy on that ARN is the gate; the endpoint form lives in the
  grant only.

Revisit the store when writes need conditions or transactions, when
backends live in other accounts, or past a few hundred backends: DynamoDB
(conditional writes, transactions, a resource policy for other accounts)
is the alternative, behind the same registry interface.

Shipped: `SharedIngress` and `AgentBackend` constructs (the one-backend
form is a `SharedIngress` with `defaultBackend` plus one `AgentBackend`, no
separate wrapper); `ingressRoleArn` and `registryPrefix` among the
ingress's published parameters; spec §3.3, §4 (the registry is a stored
entity the construct now has), §5 and §6.4 carry dated notes; integ step
9-registry (two backends behind one ingress; a token scoped to one gets
403 on the other; a backend added after the ingress deploy serves within
one TTL; a drained backend is refused within one TTL), green on both
ingresses on 2026-10-28. Confirmed on that run: the interceptor event names the Gateway target,
so the `request admitted` line carries `backend` and `/billing` routed to
its own Runtime. Revisit if a deployer needs per-backend tenant roles or
per-backend concurrency.
