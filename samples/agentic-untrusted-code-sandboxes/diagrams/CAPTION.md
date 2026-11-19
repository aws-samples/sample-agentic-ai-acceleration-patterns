<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Diagram captions

Data paths for the README, one under each diagram.

Both diagrams show the gateway entry; the standalone entry (the vendor's API invoking `runCodeFunction` with IAM) replaces the agent and gateway on the left and is otherwise the same.

Components: a tenant's agent calls `run_code` through the tools gateway, which signs the tenant context; the tool vends a `TenantId`-tagged role to read the tenant's input and registry row, and sends the code and bytes to that tenant's sandbox (MicroVM, Nitro task or AgentCore session), whose runner returns the result.

Architecture: the AgentCore Gateway invokes the `run_code` Lambda in the tool subnets, which reads the tenant's row and input with tenant-scoped credentials and sends code and bytes to the tenant's Lambda MicroVM, Nitro Sandbox task or AgentCore session in sandbox subnets that have no route to the internet, only the ECR, S3 and Logs endpoints and, optionally, a DNS Firewall that resolves only AWS names.
