<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0023: Tune the ingress cold and hot paths by measurement

- Status: Accepted
- Date: 2026-10-27
- Amends: ADR-0015
- Deciders: Dave Roberts (PSA)

## Context
A performance pass measured the `api-gateway` ingress in `eu-central-1` (`session=user`, `tvm=true`). The warm path was already tight: the ingress adds about 6 ms of its own work on top of the Runtime. The cold path was not: the first request of a Lambda environment paid 1,064 ms in the authoriser (OIDC discovery and JWKS fetch inside the first `verify`) and 770 ms in the ingress (227 ms init plus 543 ms of first-request work: the same fetches, the first STS call, and a TLS handshake each to DynamoDB and the AgentCore Runtime endpoint). A new conversation also pays the Runtime's microVM boot (about 1.3 s), which is the Runtime's and does not move.

Two hot-path items were also found. The TVM waits for STS on about one request in a thousand (the one that lands after the refresh margin). The limiter's DynamoDB client had the SDK defaults, three attempts with no timeouts, so an impaired table could hold a request for tens of seconds before the fail-open admitted it (ADR-0020).

Lambda bills the init phase, so moving work there is a gain only when the work would otherwise run on the first request anyway.

## Options considered
### Option 1: Leave the cold path to the platform
Pros: no code. Cons: every new environment costs the caller about 1.8 s of first-request work that the init phase could absorb at boosted CPU.
### Option 2: Provisioned concurrency or SnapStart
Pros: removes the cold start from the caller's view. Cons: a standing cost per environment for a sample; SnapStart is not available for Node.js response streaming; neither fixes the two hot-path items.
### Option 3: Do the first request's work at init, bound the limiter's wait, refresh credentials ahead of time
Pros: the same calls, earlier and in parallel; no new resources; each change measurable on its own. Cons: a Lambda environment that is never invoked still does the init work (bounded, a few hundred ms); more code paths to test.

## Decision
Option 3, as six changes.

1. **Verifier warm-up at init.** The authoriser and the ingress fetch the discovery document and then the JWKS during init (`verifier.warm()`, which calls jose's `reload()` since the remote key set is otherwise fetched lazily on the first `verify`), and the first request awaits it. Authoriser cold start 1,064 ms to 537 ms with the discovery fetch alone.
2. **Ingress clients at init.** The pipeline, the TVM, the limiter and the AgentCore client are constructed at module load, and the first request awaits a `ready` promise that resolves when init's pre-connects are done. Ingress cold path 770 ms to 692 ms before pre-connects.
3. **One HTTPS pool per process, pre-connected at init** (`src/shared/http.ts`). Every SDK client the ingress builds shares one keep-alive agent. `warm()` opens a connection to STS (with the TVM), DynamoDB (with the limiter) and the Runtime endpoint (api-gateway ingress only) with an unsigned, empty `POST /` that needs no permission and touches no resource (a HEAD would do for DynamoDB and AgentCore, but STS closes the socket after one). The first request then reuses those sockets. A failed pre-connect is ignored; the request opens its own, as before.
4. **TVM refresh-ahead** (`REFRESH_AHEAD_MS`, two minutes). A cache hit with less than margin plus two minutes left is served from the cache and starts one background `AssumeRole` for that tag set (single flight as in ADR-0022). A background failure is logged by name and the entry stays; the request path still refreshes at the margin. Where the gain lands: a Lambda environment is frozen between invocations, so the background call finishes before the freeze only while the handler is still running. On `api-gateway` the handler holds the request for the whole backend stream (hundreds of milliseconds to minutes), longer than an STS call, so the refresh completes and the next request is a plain hit. The interceptor returns at once, so there the call resumes on the next invocation of that environment and that request waits for it; a hot tag set still refreshes without a wait only when a sibling environment did it. Either way no request waits longer than it did before.
5. **Limiter client bounded** (`LIMITER_CLIENT`): `maxAttempts: 2`, 500 ms to connect, 1,000 ms per attempt. Under DynamoDB impairment a request waits at most about three seconds before the fail-open admits it. Trade-off: during an impairment a few more requests are admitted than before, which is the behaviour ADR-0020 chose.
6. **Authoriser result cache 60 s to 5 min** (amends ADR-0015). The cache is keyed on the whole `Authorization` header and the integration Lambda re-verifies the token, including `exp`, before any invoke, so the cache saves authoriser invocations without extending any token's life. A chatty client with one token now reaches the authoriser Lambda once in five minutes instead of once a minute. The invariant in ADR-0015 ("a cached Allow never outlives the Lambda's own check") is unchanged; only the staleness bound of the cached Allow moves from 60 s to 300 s, and that bound matters only to the access log's `tenantId`, which the authoriser context carries and which does not change for a given token.

Also in the same pass: the agent bundle is minified (1.5 MB to 604 KB), Lambda bundles ship without source maps (ingress 3.3 MB to 672 KB), and the agent shares one keep-alive handler across its per-request clients. These change size and reuse, not behaviour.

## Consequences
Easier: a cold environment's first request is shorter by the work moved to init, and the cost of that work is billed once per environment instead of once per environment plus the caller's wait. A busy tenant does not see STS latency. An impaired limiter table degrades to admit-after-three-seconds instead of admit-after-a-minute.

Harder: `warm()` is now asynchronous and the handlers await `ready`; a test that builds the dependencies itself must not call it against the network. The regional endpoint host is derived from `AWS_REGION` (`endpointHost`); a custom endpoint or a PrivateLink DNS name would need the pre-connect host to follow it. The threat model's M-6 and T-12 read 300 s where they read 60 s.

Measured in `eu-central-1` on the ingress Lambda of `api-gateway`, from its log group (the first `request served` line of each log stream whose REPORT line carries an init duration; own work is `totalMs` minus the backend invoke): the ingress's own work on a cold environment's first request went from 545 ms (baseline, ten environments) to 359 ms (changes 1 and 2) to 198 ms (changes 3 and the JWKS fetch at init); init went from 227 ms to about 330 ms. The 200 ms left is the first real `AssumeRole` and `UpdateItem` and the SDK's first-command setup, none of which can run before a tenant arrives. The warm path is unchanged at about 5 ms. The client-side table is in the README under Latency; `scripts/perf.sh` reproduces it.

Revisit if measurement shows the pre-connects are not reused (the Agent keys sockets by host and TLS options; the SDK's request must match), or if SnapStart becomes available for Node.js response streaming.
