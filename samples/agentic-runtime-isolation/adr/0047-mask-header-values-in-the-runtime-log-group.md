<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0047: Mask header values in the Runtime log group with a data protection policy, set from a custom resource

- Status: Accepted
- Date: 2026-11-06
- Amends: ADR-0019 (the Runtime's own log groups, left to the integration test and the README)
- Deciders: Dave Roberts (PSA)

## Context
The agent in the microVM holds two header values: the transaction token (a JWT, five minutes) and the vended tenant credentials (base64 JSON of an STS credential set, 15 minutes by default). The agent code never logs or echoes either (M-12), and the V-7 sweep finds none in any log group. That wall is agent code alone: the execution role may `PutLogEvents` to the Runtime's own group, so a prompt injection, a dependency compromise or an agent bug that writes a header value puts a live, tenant-scoped credential or token into a log group readable by anyone with `logs:GetLogEvents` in the account (T-18 residual). The blast radius stays inside one tenant (T-22), but a leaked credential outlives the request for its lifetime, and the log keeps it after that.

CloudWatch Logs data protection policies mask matching values at ingest; `logs:Unmask` reads the original. A policy on the Runtime's group turns the agent-code wall into a service-side one.

The Runtime's group, `/aws/bedrock-agentcore/runtimes/<id>-DEFAULT`, is created by the service at `CreateAgentRuntime` and named after an id known only then. ADR-0019 left it out of the stack: the integration test deleted it after destroy and the README told a deployer to do the same. The group also has no retention.

## Options considered
### Option 1: Own the group as an `AWS::Logs::LogGroup` named `/aws/bedrock-agentcore/runtimes/${AgentRuntimeId}-DEFAULT`
Pros: the CDK `DataProtectionPolicy` class, retention and removal policy for free. Cons: the service creates the group first, within the `CreateAgentRuntime` call, so the stack's create fails with `AlreadyExists` (integration run 2026-11-06, both all-on stacks rolled back). Not possible.

### Option 2: A custom resource after the Runtime
Pros: per Runtime; the sample's existing idiom (`LogDrain`, `RegistryEntry`, `ToolPolicy`); also fixes the missing retention and deletes the group on destroy. Cons: one more small Lambda (about 30 s of deploy); the policy document is hand-built JSON, not the CDK class; a line written between the resource's Delete and the Runtime's recreates the group outside the stack, as before.

### Option 3: An account data protection policy (`AWS::Logs::AccountPolicy`)
Pros: one resource, no Lambda, covers every log group in the account and Region, including the ingress ones. Cons: one such policy per account, so a second stack, a second sample or a deployer's own policy conflicts; a sample stack should not own an account-wide setting; it cannot be scoped to a prefix.

### Option 4: A README runbook (`put-data-protection-policy` by hand)
Pros: no code. Cons: not enforced; the group still has no retention.

## Decision
Option 2. `AgentCoreRuntimeBackend` creates a `Custom::RuntimeIsolationRuntimeLogGroup` resource that depends on the Runtime. Its handler (`src/backend/runtime-log-group.function.ts`) creates the group if the service has not yet (`ResourceAlreadyExistsException` is success), puts a 30-day retention and the data protection policy on it, and on Delete deletes the group named by its PhysicalResourceId. The policy (`runtimeLogDataProtectionPolicy`, `MASKED_PATTERNS`) masks whole values: a JWT (`eyJ` and two more base64url segments), the base64 credential header (its prefix is the base64 of `{"accessKeyId":`, the key order `encodeCredentials` writes), and the decoded credential object's `secretAccessKey` and `sessionToken` fields in the three spellings a Node process produces (`JSON.stringify`, the same nested in a JSON log line, `console.log` of an object); the managed `AwsSecretKey` identifier covers the CLI and SDK spellings (`aws_secret_access_key = ...`). The handler's role holds `CreateLogGroup`, `DeleteLogGroup`, `PutRetentionPolicy` and `PutDataProtectionPolicy` under the `/aws/bedrock-agentcore/runtimes/*` prefix (the same resource as the execution role's log statement): after a Runtime replacement CloudFormation deletes the old group through the new resource's role, so one exact name would not do. No `logs:Unmask` anywhere in the sample.

Verified 2026-11-06 in the sandbox account: all four Runtime groups of the integration stacks came up with retention 30 and `dataProtectionStatus: ACTIVATED`; probe lines holding a fake JWT, a fake credential header and a fake decoded credential object in all three spellings read back with the secret values as asterisks, a plain line unchanged, and `--unmask` returned the originals; destroy left no Runtime group. That hand probe is now integration step `mask`, so the patterns are proven on CloudWatch's engine on every run, not only on the JS engine of the unit tests.

The policy changes what the V-7 log sweep (integration step `sweep`) sees. A value the agent leaks into a Runtime group is stored masked, so a plain `filter-log-events` returns asterisks and the sweep's `eyJ` and signature-segment greps would pass whether or not the agent leaked. The sweep therefore reads the Runtime groups with `--unmask` (the integration runner holds `logs:Unmask`; a failed unmasked read fails the step instead of counting as zero lines), and checks that `LogEventsWithFindings` (AWS/Logs) over those groups is 0 for the run, the service-side count no mask can hide. The `mask` step runs after the sweep, because its probe lines would otherwise be counted as hits.

## Consequences
Easier: a rogue agent that logs a header value leaks it only to `logs:Unmask` holders; the Runtime group has a retention and goes with the stack; `LogEventsWithFindings` (AWS/Logs) counts every match, so a deployer can alarm on the first one. Two CloudWatch Logs regex rules found on the way, both probed with `PutDataProtectionPolicy` on 2026-11-06: an open-ended `{n,}` quantifier (probed with `{16,}`) is accepted but never matches; and a large explicit bound behind a short literal is refused as "Regexes in Custom Data Identifiers are too complex" (`eyJ[A-Za-z0-9_-]{1,200}` and three `{1,50}` JWT segments rejected, `{1,100}` accepted), while `+` is accepted and matches. The JWT and credential-header patterns therefore use `+` (their length is not known), the secret-access-key and session-token patterns a `{m,n}` bound (`{40}`, `{16,4096}`, which the engine takes behind their longer literal prefix); a unit test refuses `{n,}` and `*`. Harder: data protection is billed per GB scanned (see CloudWatch pricing), about 30 s more deploy, and the policy takes a short while (tens of seconds) to apply to a new group, so the very first lines after a deploy are not masked. Unchanged: the agent code still never logs a header value; the policy is the second wall, not the first. The group cannot join the `LogDrain` (the resource depends on the Runtime, the drain would have to depend on the resource, and the Runtime would then have to go first: a cycle), so a line written after the resource's Delete recreates the group outside the stack, without retention or policy; the integration test deletes such a leftover and the README tells a deployer to check. The same window opens on a Runtime replacement: the group name follows `AgentRuntimeId`, so CloudFormation creates the new group's resource and then deletes the old group through the new resource's Delete while the old Runtime is still draining; a late line from it recreates the old group outside the stack in the same way, and the README's post-destroy check applies after a replacement too. Revisit if `AWS::BedrockAgentCore::Runtime` gains a log-group or data-protection setting, or if CloudWatch account policies gain a log-group-prefix scope.
