<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Tenant front door: spike record

The measurements behind the specification
([§9](./tenant-front-door.spec.md)). Each spike states its question, what had
to be true to pass, and what was measured. Each reports its deploy and
destroy time.

## S-1

Function and store on a multi-tenant distribution; logging Region.

**Question.** Does a multi-tenant distribution take a viewer-request
function with an associated KeyValueStore, on both an apex and a wildcard
pooled distribution tenant?

**Pass criterion and result.** A request runs the function and reads the
store in both; standard logging v2 set up in `us-east-1` (delivery source,
delivery destination and delivery) delivers to a log group in
`eu-central-1`. **Passed 2026-11-16, with a logging change**: the function
read the store on both tenants (apex and `a.` under the wildcard), 200
within 46 s of deploy. A CloudWatch Logs delivery to another Region is
refused (`Cross-region Delivery Destination is not supported`), and a
delivery destination must be in its log group's Region. With the log group
in `us-east-1` logs arrived in 33 s; with an S3 bucket in `eu-central-1`
(destination and delivery in `us-east-1`) in 312 s. The log group is in
`us-east-1` (ADR-0010). Deploy 481 s, destroy 312 s.

## S-2

KeyValueStore propagation time.

**Question.** How long does a KeyValueStore write take to apply at the edge?

**Pass criterion and result.** Median and p99 from write to first routed
request. **Measured 2026-11-16** over 100 rounds (one POP, 250 ms polling):
median 28.4 s, p90 29.2 s, p99 29.4 s, max 29.5 s from the start of
`put-key` to the first routed request; 29.6 s median until four pollers all
saw it; no timeouts; inserts and updates alike. `put-key` itself takes about
0.6 s. Deploy 340 s.

## S-3

Origin access control to a function URL in another account.

**Question.** Does `cf.updateRequestOrigin()` set origin access control for
a Lambda function URL **in another account**?

**Pass criterion and result.** Through the multi-tenant distribution, with
its ARN as the permission's `SourceArn`: a signed request reaches a URL with
`AWS_IAM` auth in the second account; an unsigned one is 403; a `POST` with
a body and `x-amz-content-sha256` is served; the cell receives the viewer's
token in `x-tenant-token`; the permission set is confirmed. **Passed
2026-11-16**: a signed `GET` and a `POST` with `x-amz-content-sha256`
reached the function URL in the second account through the multi-tenant
distribution, with the distribution ARN (not the tenant ARN) as `SourceArn`;
the cell saw the viewer's token in `x-tenant-token`, and a client's own
`x-tenant-token` was replaced. Refused with 403: a direct unsigned call, a
call before the permission existed, a `POST` without `x-amz-content-sha256`
(signature mismatch), and a call with `lambda:InvokeFunctionUrl` but no
`lambda:InvokeFunction`. Lambda removes the signed `Authorization` header
from the event. Deploy 506 s, destroy 185 s.

## S-4

One callback URL per tenant, or a shared sign-in host.

**Question.** `host` mode: how does the issuer take one callback URL per
tenant at 1,000s of tenants?

**Pass criterion and result.** A working option for Cognito app clients
(limit and update rate measured), or a single sign-in host with a signed
`state`. **Passed 2026-11-16 with the shared sign-in host**: one Cognito app
client takes 100 callback URLs (the 101st is refused), a pool 1,000 clients
by default, and `UpdateUserPoolClient` about 15 per second before
`TooManyRequestsException`. One sign-in host with a signed `state` completed
a real hosted sign-in and sent the code to the tenant host; a missing,
changed or expired `state`, or a host outside `appDomain`, got 400. A
wildcard callback URL is saved but matched as a literal string: a tenant
host gets `redirect_mismatch` (ADR-0016). Deploy 446 s, destroy 220 s.

## S-4o

Cognito `/logout` and the `state` parameter.

**Question.** `host` mode: does Cognito's `/logout` return `state` on its
`logout_uri` redirect, and which `/logout` form brings a user back to a
tenant host?

**Pass criterion and result.** The observed redirect for the `logout_uri`
form and the `redirect_uri` form, and for an unregistered `logout_uri`.
**Measured 2026-11-16**: `/logout` with `client_id`, a registered
`logout_uri` of `https://login.<appDomain>/logout` and `state` answered 302
to the `logout_uri` with `state` dropped, and ended the session (the next
authorize showed the sign-in form). An unregistered `logout_uri`, on another
domain or a tenant host, was refused with a redirect to Cognito's own
`/login` page. `/logout` with `client_id`, `response_type=code`,
`scope=openid`, a registered `redirect_uri` of
`https://login.<appDomain>/callback` and `state` answered 302 to Cognito's
`/login` with `state` kept; after sign-in the code reached the callback with
the same `state`. A live session gave a code without the sign-in form, and
both `/logout` forms ended it: the next authorize showed the form again
(rerun 2026-11-17). The design uses the `redirect_uri` form (ADR-0016).
Deploy 39 s, destroy 31 s.

## S-5

Streaming through `/agents/*`.

**Question.** Does streaming pass through `/agents/*` to the agent ingress
without buffering?

**Pass criterion and result.** First byte at the client within 1 s of first
byte from the ingress; the ingress receives the bearer token on `GET` and
`POST` (the real ingress serves only `POST`, so the `GET` check proves that
the origin request policy forwards the token on `GET`, not a route); the
ingress sees the path without `/agents`, as `<stage>/<backend>/invocations`
(ADR-0019); the `Managed-AllViewerExceptHostHeader` policy deploys with the
pinned CDK version. Recorded as negatives: `/agents` and `/agents/` get 404
at the edge. **Passed 2026-11-18**, eu-central-1 ingress stand-in (REST API,
REQUEST authoriser, streaming Lambda proxy) behind a standard distribution
in us-east-1, 20 rounds each of `GET` and `POST`: every stream 200 and
complete; first byte p50 13 ms and max 14 ms after the ingress wrote it
(direct baseline p50 16 ms, so CloudFront added none); one event per read
and client gaps of 480 to 500 ms for 500 ms writes, so nothing was buffered;
the bearer reached the ingress on both methods; the ingress saw
`/s5/invocations` (`/prod/s5/invocations` with the stage), no `/agents`;
`aws-cdk-lib` 2.274.0 synthesized and deployed policy `b689b0a8-…`, named
`Managed-AllViewerExceptHostHeader`. Negatives: `/agents/` got the router's
404; `POST /agents` got CloudFront's own 403, because the default (SPA)
behaviour allows only `GET` and `HEAD`, so the router never ran; neither
reached the ingress. A `tenant-only` distribution is not covered by S-5; §10
step 23 verifies it. Deploy 67 s ingress and 221 s edge; destroy 33 s and
186 s.

## S-6

WAF rate rule keyed on `Host`.

**Question.** Does a WAF rate rule keyed on the `Host` header count each
tenant on its own?

**Pass criterion and result.** Tenant A over its limit on `/api/*` gets the
custom 429 while tenant B is served; A's SPA loads (`/`, `/assets/*`) are
not counted. **Passed 2026-11-16**: limit 10 per 60 s keyed on the
lower-cased `Host`, scoped down to `/api/`. Tenant A got the custom 429
(JSON body, `retry-after: 60`) 21 s into its burst while B's `/api/x` stayed
200; 300 requests to A's `/` and 100 to `/assets/app.js` during the block
were all 200. The rule's managed-keys call does not support a `Host` key.
Deploy 443 s, destroy 250 s.

## S-7

Decoding a token at the edge.

**Question.** Can the router decode a `tenant-identity` access token's
payload within the CloudFront Functions limits?

**Pass criterion and result.** `tenant_id` read from a real token; compute
utilisation under 50 %; 401 on a malformed token. **Passed 2026-11-13**:
13-14 % compute, 401 at 9-10 % (ADR-0005).

## S-8

Resource policy that admits a role by `aws:PrincipalArn`.

**Question.** Can an API Gateway resource policy admit a role name in any
account through `aws:PrincipalArn`, and does the request context give the
caller's account?

**Pass criterion and result.** A provisioning role in the second account
reaches the registrar; a role of another name is refused. **Passed
2026-11-13** with one design fix: the second account's provisioning role got
200 with `identity.accountId` and `userArn` in the request context; another
role name got 403. The edge account's own admin also got 200 through its
identity policy, so the resource policy adds an explicit `Deny` with
`ArnNotLike` (§3.4). Deploy 75 s, destroy 33 s. The result holds for the
control plane's `<fleet>-global-hook` role, the principal the registrar
admits (ADR-0017): one role ARN, matched by the same cross-account
`aws:PrincipalArn` condition and guarded by the same `Deny`.

## S-9

Client-credentials token against the control plane authorizer.

**Question.** Does a client-credentials token from the registrar's own
vendor IdP client pass the control plane authorizer (single `audience`,
required `sub` and `role`)?

**Pass criterion and result.** `GetCell` returns 200 with that token, the
token's `role` is the reader value, and a write returns 403. **Failed
2026-11-13; fallback proven**: the token has no `aud` (`sub` equals
`client_id`), and the audience check denies it. A V3 trigger on the
Essentials plan adds `role: control-plane:reader` but its `aud` override is
ignored. With a `client_id` allow-list in place of the audience check, the
same token is allowed with the reader grant (ADR-0015, §6.1). Deploy 36 s
per phase, destroy 61 s.

## S-10

What the registrar function sees from its default resolver.

**Question.** What does the registrar's Lambda function, outside a VPC, see
from its default resolver for a challenge record (ADR-0018)?

**Pass criterion and result.** The resolver it uses is reported; a TXT
record published under a fresh name is seen on the first lookup; after a
lookup that found no record, the time until a newly published record is seen
is measured against the zone's negative-caching TTL; after a value change,
the time until the new value is seen is measured against the record's TTL; a
record split into several strings is read whole; the longest the resolver
keeps a passing answer, against a record whose TTL is above it (its TTL
cap). The first figures are the delay an operator meets between publishing
and a passing repeat; the TTL cap bounds how long a removed record can still
pass, which delays the daily re-check's alarm (§3.4 step 5). Every delay is
measured from the change's `INSYNC`. Passes when no cached answer causes a
pass for a value that was never published, every delay before a published
record or a changed value is seen stays within the record's TTL, capped at
the resolver's, or the zone's negative-caching TTL, and a removed record
stops being served within a day (the daily re-check's bound). **Passed
2026-11-18**, a Node.js 22 function outside a VPC in `eu-central-1` against
a public test zone with an SOA TTL of 900 and a minimum of 86400, so a
negative-caching TTL of 900 s. Each probe was three concurrent invocations
(four `resolveTxt` lookups and one raw query to the resolver each, and a
control query to the zone's name server from one), a new set of invocations
every poll, and every 240 s a configuration change that forced new execution
environments. The resolver is a link-local address from `/etc/resolv.conf`
(`timeout:2 attempts:5`); a lookup takes 2 ms at the median. A fresh name
was seen on 15 of 15 first lookups, with the record's TTL. **Negative
answers last**: after NXDOMAIN the zone's name server had the record 23 s
before `INSYNC`; all three first lookups saw it 3 s before `INSYNC`, yet 145
of 1,590 queries (9 %) still got NXDOMAIN, and the last stale answer came
697 s after `INSYNC` (732 s after the negative lookup). A second name (an
empty non-terminal, also answered NXDOMAIN) had 166 of 1,575 queries stale,
the last 851 s after `INSYNC` (882 s after the negative lookup), both inside
900 s. S-10's data shows that lookups in one invocation disagree: the first
lookup was stale in 28 of 318 invocations (34 of 315 for the second name),
all five in only 7 (3). An environment whose first lookup was stale got a
stale first lookup on its next invocation about half the time (14 of 24 and
16 of 31), and queries from cold-start environments were stale as often (10
of 60 and 5 of 55), so the cache is behind the resolver address, not in the
environment. **A changed value** was read as the old one for at most its
TTL: the last old answer came 31 s after `INSYNC` at TTL 60 and 181 s after
`INSYNC` at TTL 300. A record of two strings (255 + 255) and one of three
(255 + 255 + 43) arrived as an array of strings and joined equal the
published value on 24 of 24 lookups. **TTL cap**: a record with TTL 86400
came back with TTL 300, and after its removal the old answer was still given
631 s after `INSYNC` (661 s after the deletion, 9 of 61 polls) and never in
the last 19.5 minutes of the 30-minute cap. A zone name server answered
every control query over UDP from the function. S-10 met the pass criterion:
no answer held a value before it was published, the last cached negative
answers came 697 s and 851 s after `INSYNC`, inside the 900 s
negative-caching TTL, the last old values came 31 s after `INSYNC` at TTL 60
and 181 s after `INSYNC` at TTL 300, and the deleted record was last served
631 s after `INSYNC` (661 s after the deletion), within the one-day bound of
the daily re-check (§3.4 step 5). Deploy 67 s plus 7 s for the function
code; destroy 32 s for the stack and 35 s for the DNS records.

## Smoke run, 2026-11-19

`scripts/smoke.sh`: the built sample in `single` mode with one demo cell,
before the control plane's hooks exist. Routes are seeded straight into the
route table (the §10 step 2 shortcut); the control plane the front door
names does not exist.

**Found and fixed.** (1) CloudFront refuses `x-amz-content-sha256` in an
origin request policy (`InvalidRequest`), so the `/api/*` policy forwards
three headers; a `POST` with the body's SHA-256 in that header was served by
the cell and one without it got Lambda's 403, so origin access control reads
the viewer's header itself (§3.2). (2) `cloudfront-js-2.0` refuses `await`
inside call arguments at load (`SyntaxError: await in arguments not
supported`), which made every request 503 with `FunctionExecutionError`;
the router reads the value first, and a source test refuses the pattern.

**Result.** 39 of 39 checks passed: the SPA, `/config.json`, `/logout` and
`/signin-state` with the §7.1 headers; `/api/whoami` for two tenants through
origin access control; 401 with no token and with an `Authorization` header
over 8,192 bytes; 403 for an unrouted tenant, `Sec-Fetch-Site: same-site`, a
forged payload (refused by the cell) and a direct function URL call; a
client `x-tenant-route` ignored; registrar 403 unsigned and 503 for
`PutCellRoute` with the control plane unreadable; and `UpdateTenantRouteStatus`
suspending and resuming a tenant with no control plane (ADR-0025), with the
other tenant still served, and 409 for a tenant with no route.

**Propagation.** From one client, polling once a second from the end of
the write, a seeded route was first served 16 to 37 s after it, and the
last request that missed it came 36 to 59 s after it (three runs). In
earlier runs, timed from the start of the seed tool (about 2 s before
the write ended), requests still missed the route up to 65 s after the
start, and 200 of 200 were routed after 3 minutes. Spike S-2 measured
the first routed request at one location; the smoke also measured the
last miss, which comes later. Spec §4.2 and §10 therefore wait
90 s where every request has to see a change. A suspension gave five
503 answers in a row 15 to 53 s after the call.

**Deploy.** Front door stacks 384 s (a fresh main stack after a failed
first attempt; the edge stack had deployed), demo cell 66 s, support 59 s.
