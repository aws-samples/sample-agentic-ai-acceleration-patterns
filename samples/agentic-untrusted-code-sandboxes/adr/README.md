<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Decisions

Once a record is accepted, its decision text is not edited. A change is a
new record with an `Amends` line; the amended record gets an `Amended by`
line and a dated trailing note saying what changed
([sample standard §2.2](../../../docs/sample-standard.md#22-architecture-decision-records-adr)).

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
| [0020](0020-filter-job-system-calls-on-microvm.md) | Filter job system calls on microvm, and back the caps with a free-memory floor | Proposed | 2026-11-19 |
| [0021](0021-close-socket-and-sysv-routes-and-reap-every-job.md) | Close the socket and SysV routes, watch the nitro group, and reap every job | Proposed | 2026-11-20 |
| [0022](0022-leave-room-for-the-runner-in-the-nitro-process-cap.md) | Leave room for the runner in the nitro process cap | Proposed | 2026-11-20 |
| [0023](0023-ship-a-compiled-package-with-a-handler-tree-on-the-pinned-cdk-and-sdk.md) | Ship a compiled package with a handler tree on the pinned CDK and SDK | Proposed | 2026-11-20 |
| [0024](0024-keep-the-runner-in-one-directory-and-copy-its-image-into-the-construct-repository.md) | Keep the runner in one directory and copy its image into the construct repository | Proposed | 2026-11-20 |
| [0025](0025-pin-the-runner-wire-protocol-and-the-backend-interface.md) | Pin the runner wire protocol and the backend interface | Proposed | 2026-11-20 |
| [0026](0026-run-the-python-tests-and-the-tree-checks-in-the-projen-build.md) | Run the Python tests and the tree checks in the projen build | Proposed | 2026-11-20 |
| [0027](0027-name-resources-from-the-construct-path-and-find-a-supplied-vpcs-subnets-by-group-name.md) | Name resources from the construct path, and find a supplied VPC's subnets by group name | Proposed | 2026-11-20 |
| [0028](0028-give-each-endpoint-class-its-own-security-group-and-name-the-s3-prefix-list-when-the-app-can.md) | Give each endpoint class its own security group, and name the S3 prefix list when the app can | Proposed | 2026-11-20 |
| [0029](0029-wire-the-functions-the-drain-and-the-log-groups-from-one-construct.md) | Wire the functions, the drain and the log groups from one construct | Proposed | 2026-11-20 |
| [0030](0030-compose-roles-from-the-backends-statements-and-keep-the-registry-actions-minimal.md) | Compose roles from the backends' statements, and keep the registry actions minimal | Proposed | 2026-11-20 |
| [0031](0031-build-the-insight-rules-at-synth-switch-per-tenant-metrics-by-environment-and-fail-the-firewall-closed.md) | Build the insight rules at synth, switch per-tenant metrics by environment, and fail the firewall closed | Proposed | 2026-11-20 |
| [0032](0032-return-tool-errors-as-values-and-write-the-registry-in-one-order.md) | Return tool errors as values, and write the registry in one order | Proposed | 2026-11-20 |
| [0033](0033-write-one-run-line-and-one-stop-line-with-fixed-fields.md) | Write one run line and one stop line, with fixed fields | Proposed | 2026-11-20 |
| [0034](0034-list-sandboxes-before-scanning-rows-and-drain-to-a-deadline.md) | List sandboxes before scanning rows, and drain to a deadline | Proposed | 2026-11-20 |
| [0035](0035-offboard-by-row-and-keep-a-row-whose-stop-failed.md) | Offboard by row, and keep a row whose stop failed | Proposed | 2026-11-20 |
| [0036](0036-test-the-registry-against-an-in-memory-engine-with-real-conditions.md) | Test the registry against an in-memory engine with real conditions | Proposed | 2026-11-20 |
| [0037](0037-name-the-backend-in-the-runner-environment-and-pin-the-runner-images.md) | Name the backend in the runner environment, and pin the runner images | Proposed | 2026-11-20 |
| [0038](0038-prepare-the-job-child-as-uid-1001-and-set-the-address-space-cap-last.md) | Prepare the job child as uid 1001, and set the address space cap last | Proposed | 2026-11-20 |
| [0039](0039-read-the-open-points-of-the-runner-protocol-one-way.md) | Read the open points of the runner protocol one way | Proposed | 2026-11-20 |
| [0040](0040-filter-microvm-calls-by-code-and-scope-iam-to-the-image.md) | Filter MicroVM calls by code and scope IAM to the image | Proposed | 2026-11-20 |
| [0041](0041-refuse-a-microvm-start-without-the-sample-connector-twice.md) | Refuse a MicroVM start without the sample's connector, in IAM and in code | Proposed | 2026-11-20 |
| [0042](0042-build-the-microvm-image-from-a-staged-artifact-with-platform-hooks.md) | Build the MicroVM image from a staged artifact, with the platform hooks enabled | Proposed | 2026-11-20 |
| [0043](0043-end-every-microvm-before-the-image-and-connector-go.md) | End every MicroVM before the image and the connector go | Proposed | 2026-11-20 |
| [0044](0044-classify-microvm-data-channel-answers-and-start-failures.md) | Classify MicroVM data-channel answers and start failures | Proposed | 2026-11-20 |
| [0045](0045-accept-nitro-instance-types-from-a-static-table-of-enclaves-families.md) | Accept nitro instance types from a static table of Nitro Enclaves families | Proposed | 2026-11-20 |
| [0046](0046-write-the-nitro-task-definition-in-l1-with-no-task-role.md) | Write the nitro task definition in L1, with no task role and the isolation mode as an override | Proposed | 2026-11-20 |
| [0047](0047-prove-and-run-on-one-pinned-tls-connection.md) | Prove the sandbox and run the job on one pinned TLS connection | Proposed | 2026-11-20 |
| [0048](0048-scope-the-nitro-statements-by-the-keys-each-action-supports.md) | Scope the nitro statements by the condition keys each action supports | Proposed | 2026-11-20 |
| [0049](0049-read-stopping-tasks-as-live-and-drain-instances-in-the-backend.md) | Read a stopping task as live, and end the instances in the backend | Proposed | 2026-11-20 |
| [0050](0050-scope-the-tool-rights-to-the-runtime-and-derive-the-session-id-in-code.md) | Scope the tool's AgentCore rights to the runtime and derive the session id in code | Proposed | 2026-11-20 |
| [0051](0051-keep-the-runtime-role-to-logs-and-the-image-and-let-the-core-open-the-network.md) | Keep the runtime role to logs and the image, and let the core open the network | Proposed | 2026-11-20 |
| [0052](0052-treat-the-session-as-always-ready-and-read-every-answer-as-a-result-a-refusal-or-a-dead-handle.md) | Treat the session as always ready, and read every answer as a result, a refusal or a dead handle | Proposed | 2026-11-20 |
| [0053](0053-run-the-runtime-from-the-construct-repository-and-never-from-a-code-zip.md) | Run the runtime from the construct's repository and never from a code zip | Proposed | 2026-11-20 |
| [0054](0054-deliver-the-usage-logs-with-resources-the-construct-owns.md) | Deliver the usage logs with resources the construct owns | Proposed | 2026-11-20 |
| [0055](0055-take-the-tenant-from-the-signed-context-only-on-the-gateway-entry.md) | Take the tenant from the signed context only on the gateway entry | Proposed | 2026-11-20 |
| [0056](0056-refuse-a-tool-budget-above-90-s-behind-the-gateway.md) | Refuse a tool budget above 90 s behind the gateway | Proposed | 2026-11-20 |
| [0057](0057-prove-the-packed-core-builds-without-the-producer.md) | Prove the packed core builds without the producer | Proposed | 2026-11-20 |
| [0058](0058-delete-the-integration-stack-through-the-api-from-the-driver-and-give-the-test-two-hooks.md) | Delete the integration stack through the API from the driver, and give the test two hooks | Proposed | 2026-11-20 |
| [0059](0059-switch-on-the-test-overrides-through-an-escape-hatch-in-the-integration-app.md) | Switch on the test overrides through an escape hatch in the integration app | Proposed | 2026-11-20 |
| [0060](0060-sign-test-tokens-with-a-mint-that-exists-only-in-the-integration-app.md) | Sign test tokens with a mint that exists only in the integration app | Proposed | 2026-11-20 |
| [0061](0061-write-down-the-run-order-and-the-step-by-instance-by-backend-matrix.md) | Write down the run order and the step by instance by backend matrix | Proposed | 2026-11-20 |
| [0062](0062-check-leftovers-read-only-against-what-the-run-owned.md) | Check leftovers read-only against what the run owned | Proposed | 2026-11-20 |
| [0063](0063-bound-the-answer-by-its-json-size-and-the-input-by-the-runner-limit.md) | Bound the answer by its JSON size and the input by the runner's limit | Proposed | 2026-11-20 |
| [0064](0064-read-an-unframed-request-as-empty-and-bound-the-work-after-a-job.md) | Read an unframed request as empty and bound the work after a job | Proposed | 2026-11-20 |
| [0065](0065-require-an-explicit-endpoint-choice-with-a-supplied-vpc.md) | Require an explicit endpoint choice with a supplied VPC | Proposed | 2026-11-20 |
| [0066](0066-mark-the-integration-app-in-module-state-not-in-context.md) | Mark the integration app in module state, not in context | Proposed | 2026-11-20 |
| [0067](0067-let-the-core-write-every-endpoint-policy-from-log-cleanup.md) | Let the core write every endpoint policy from its own resources and `logCleanup()` | Proposed | 2026-11-20 |
| [0068](0068-trust-the-connector-operator-role-without-a-source-account-condition.md) | Trust the connector operator role without a source account condition | Proposed | 2026-11-20 |
| [0069](0069-publish-no-parameter-from-the-demo-stack.md) | Publish no parameter from the demo stack | Proposed | 2026-11-22 |
| [0070](0070-scale-in-nitro-instances-two-minutes-after-the-last-task.md) | Scale in `nitro` instances two minutes after the last task | Proposed | 2026-11-22 |