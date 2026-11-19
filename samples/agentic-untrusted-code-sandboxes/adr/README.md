<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Decisions

| Number | Title | Status | Date |
| --- | --- | --- | --- |
| [0001](0001-serve-every-boundary-behind-one-run-code-tool-target.md) | Serve every boundary behind one run_code tool target | Proposed | 2026-11-18 |
| [0002](0002-model-each-boundary-as-a-pluggable-sandbox-backend.md) | Model each boundary as a pluggable sandbox backend | Proposed | 2026-11-18 |
| [0003](0003-give-sandboxed-code-no-internet-and-the-fewest-credentials.md) | Give sandboxed code no internet and the fewest credentials each backend allows | Proposed | 2026-11-18 |
| [0004](0004-run-nitro-sandboxes-on-ecs-managed-instances.md) | Run Nitro Sandboxes on ECS Managed Instances, not EKS | Proposed | 2026-11-18 |
| [0005](0005-keep-one-sandbox-per-tenant-in-a-tenant-keyed-registry.md) | Keep one sandbox per tenant in a tenant-keyed registry | Proposed | 2026-11-18 |
| [0006](0006-pass-input-bytes-in-and-never-let-the-sandbox-fetch.md) | Pass input bytes in, and never let the sandbox fetch | Proposed | 2026-11-18 |
| [0007](0007-make-per-session-files-on-agentcore-opt-in.md) | Make per-session files on AgentCore opt-in | Proposed | 2026-11-18 |
| [0008](0008-drive-the-integration-test-with-the-cdk-cli.md) | Drive the integration test with the CDK CLI | Proposed | 2026-11-18 |
| [0009](0009-derive-the-agentcore-session-id-from-the-tenant-alone.md) | Derive the AgentCore session id from the tenant alone | Proposed | 2026-11-18 |
| [0010](0010-run-code-as-a-separate-user-and-prove-the-sandbox-on-every-call.md) | Run code as a separate user, and prove the sandbox on every call | Proposed | 2026-11-18 |
| [0011](0011-stop-sandboxes-with-a-reaper-a-drain-and-an-offboard-function.md) | Stop sandboxes with a reaper, a drain and an offboard function | Proposed | 2026-11-18 |
| [0012](0012-split-the-vpc-into-tool-subnets-and-dead-end-sandbox-subnets.md) | Split the VPC into tool subnets and dead-end sandbox subnets | Proposed | 2026-11-18 |
| [0013](0013-attribute-runs-and-sandbox-seconds-from-the-tool-log.md) | Attribute runs and sandbox seconds from the tool log | Proposed | 2026-11-18 |
| [0014](0014-start-and-stop-nitro-tasks-with-the-tool-tenant-role.md) | Start and stop nitro tasks with the tool tenant role | Proposed | 2026-11-18 |
| [0015](0015-apply-the-spike-results.md) | Apply the spike results | Proposed | 2026-11-18 |
| [0016](0016-offer-a-dns-firewall-as-an-option.md) | Offer a DNS Firewall as an option | Proposed | 2026-11-19 |
| [0017](0017-split-the-core-from-the-gateway-entry.md) | Split the core from the gateway entry | Proposed | 2026-11-19 |
| [0018](0018-deliver-the-nonce-on-the-data-channel-and-bind-every-job-to-it.md) | Deliver the nonce on the data channel and bind every job to it | Proposed | 2026-11-19 |
| [0019](0019-cap-job-memory-per-backend.md) | Cap job memory per backend | Proposed | 2026-11-19 |