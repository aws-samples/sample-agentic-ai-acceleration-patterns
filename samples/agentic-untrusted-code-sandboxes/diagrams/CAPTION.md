<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Diagram captions

Data paths for the README, one under each diagram.

Both diagrams show the gateway entry; the standalone entry (the vendor's API invoking `runCodeFunction` with IAM) replaces the agent and gateway on the left and is otherwise the same.

Components: a tenant's agent calls `run_code` through the tools gateway, which signs the tenant context; the tool verifies it, vends a `TenantId`-tagged role to read the tenant's input and registry row (and, for the Nitro task, to start and stop it), and sends the code and bytes to that tenant's sandbox (MicroVM, AgentCore session or Nitro task), whose runner returns the result. The reaper, the drain and `offboardTenant` are separate vendor-side functions: the reaper and the drain have their own roles and `offboardTenant` runs as the reaper role. They read the registry and stop sandboxes, and only the drain can end instances. The optional DNS Firewall applies to the sandbox trust zone.

Architecture: the AgentCore Gateway invokes the `run_code` Lambda in the tool subnets, which reads the tenant's row and input with tenant-scoped credentials. The job reaches the tenant's Nitro Sandbox task over one direct TLS connection on port 8443. It reaches the tenant's Lambda MicroVM and AgentCore session through the NAT gateway, over HTTPS to the MicroVM ingress and the AgentCore data plane. The sandbox subnets have no route out: the Nitro task reaches only the Logs endpoint, the AgentCore runtime only the ECR, S3 and Logs endpoints, and the MicroVM connector nothing. An optional DNS Firewall resolves only AWS names. The reaper, drain and offboard function read the registry and stop sandboxes; only the drain also ends instances.
