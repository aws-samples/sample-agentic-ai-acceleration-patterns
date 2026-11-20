<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0004: Run Nitro Sandboxes on ECS Managed Instances, not EKS

- Status: Proposed
- Date: 2026-11-18
- Amended by: ADR-0015
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

Nitro Sandboxes give a pod, task or VM its own VM and kernel on a shared
EC2 instance. They work on EKS (`runtimeClassName: isolated-sandbox`,
Kubernetes 1.36 or later), on ECS Managed Instances
(`trustedExecutionConfiguration.isolationMode: ISOLATED_SANDBOX`, Nitro
Enclaves on the capacity provider, `awsvpc` networking), and on EC2 with
the vendor's own VMM. The sample needs the boundary, not a cluster to
teach.

## Options considered

### Option 1: ECS Managed Instances
Pros: CloudFormation supports the task definition setting; no control
plane to run; per-task ENI and security group; scales to zero instances.
Cons: a task starts in seconds, not milliseconds (spike S-7); idle
instances bill.

### Option 2: EKS 1.36 with a sandbox node group or EKS Auto Mode
Pros: the network-isolated annotation removes the network device
entirely; Auto Mode needs no node group. Cons: a cluster deploy takes 15
minutes or more and the control plane bills per hour; the sample would
teach Kubernetes as much as the boundary.

### Option 3: EC2 with Firecracker in a Nitro Sandbox
Pros: full control. Cons: the vendor owns the VMM and the image; far
beyond a sample.

## Decision

Option 1. It gives the same boundary with the smallest deploy and no
cluster to operate. Network isolation comes from subnets and security
groups instead of the EKS annotation, and spike S-6 measures it.

## Consequences

The `nitro` backend needs sandbox subnets with no route out and a CloudWatch
Logs interface endpoint (ADR-0012), and a reaper to stop idle tasks
(ADR-0011). Tasks are addressed by private IP, so each call proves the
task's identity (ADR-0010). EKS readers get a
README note mapping the same settings to the pod spec. Confidential mode
stays out of scope (spec §1.2).

Note 2026-11-18: amended by ADR-0015. The default instance type is `m7i.xlarge`, the only type run end to end (`m7i.large` has no Nitro Enclaves support; `m7g.large` reports support but was not run on ECS). The instance role is named `ecsInstanceRole*`. The drain waits for every task to stop before the capacity provider goes.
