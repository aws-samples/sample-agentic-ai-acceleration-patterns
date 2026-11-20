<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Untrusted code sandboxes for agentic applications

One `run_code` tool that runs model-written Python for one tenant at a time
in a per-tenant sandbox: Lambda MicroVMs, Nitro Sandboxes on ECS Managed
Instances, or AgentCore Runtime. The sandboxed code has no internet and no
tenant credentials.

This sample is being built. The design is the contract:

- [Specification](design/agentic-untrusted-code-sandboxes.spec.md)
- [Decisions](adr/README.md)
- [Threat model](threat-model.md)
- [Runner wire protocol](runner/PROTOCOL.md)
- [Conventions for contributors and scripts](scripts/CONVENTIONS.md)

Build and test:

```bash
npm ci
npx projen build
```
