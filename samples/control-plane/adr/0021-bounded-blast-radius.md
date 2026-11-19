# ADR-0021: Bounded blast radius for amplification and log exposure (threat model M15/M17)

**Status:** Accepted (2026-09-15) — amended by ADR-0044 (the caps and retention cover the hook projects)

**Context:** Each CreateTenant can create a cell and run up to two
hour-long CodeBuild builds — a leaked token or runaway client is a
cost/concurrency amplification vector (T16). Separately, build logs are
readable by anyone with log-group access, sample scripts echoed fetched
parameter values, and the Lambda/CodeBuild service-created log groups never
expire (T13).

**Decision:** Amplification: `concurrentBuildLimit: 5` on both CodeBuild
projects (excess builds queue rather than fan out) plus two action-less
CloudWatch alarms — state machine `ExecutionsStarted` > 20/5min and API 4XX
> 50/5min — surfacing the abuse signature without SNS plumbing the sample
doesn't need. Log exposure: explicit ONE_MONTH log groups for both Lambdas
and both CodeBuild projects; sample scripts log parameter NAMES, never
values, and never echo `ADMIN_EMAIL` (PII); the convention is codified in
`scripts/CONVENTIONS.md` for provisioning-script authors.

**Consequences:** A token holder inside throttle limits can still spawn
builds, but parallel spend is capped and the attempt alarms within minutes.
Queued builds add latency under legitimate burst load — acceptable at
sample scale, tune the limit for real fleets. Log values age out in a
month; scripts that need to deliver secrets must use SSM
SecureString/Secrets Manager environment integration (masked by CodeBuild),
per the conventions doc. None of this prevents a determined
value-echoing script — the convention is a contract with script authors,
the retention bound is the backstop.

**Amended by ADR-0044 (2026-11-17):** the concurrent build cap of M17 and the one-month log retention cover the two hook projects as well as the two provisioning projects. A hook start refused at the cap is tried again for at most 5 minutes; a delete hook skipped after its retries is counted in a metric with an alarm (no actions).

**Amended by ADR-0046 (2026-11-18):** the concurrent build cap of M17 is the construct prop `concurrentBuildLimit`, an integer from 1 to 100, default 5, applied to every CodeBuild project the control plane creates; above 20 the synth warns.
