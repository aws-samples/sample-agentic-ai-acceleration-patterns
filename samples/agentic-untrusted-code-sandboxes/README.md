<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Untrusted code sandboxes for agentic applications

One `run_code` tool that runs model-written Python for one tenant at a time
in a per-tenant sandbox: Lambda MicroVMs, Nitro Sandboxes on ECS Managed
Instances, or AgentCore Runtime. The sandboxed code has no internet access
and no tenant credentials.

DNS is the one exception. With `dnsFirewall` off, which is the default, code
can look up any public name, so it can send data out and read replies in
lookups, and on `agentcore` it can send the runtime role's credentials that
way. Turn `dnsFirewall` on to resolve only AWS names plus the `allowDomains`
you list (it needs the VPC the construct creates, not a supplied `vpc`).
Each listed name needs two labels; that refuses only a bare top-level domain,
not a public suffix such as `co.uk` or a shared zone, so you are responsible
for listing only names you control (threats T-29, T-32 and T-91).
With a supplied `vpc`, set `createEndpoints` explicitly: the endpoints use
private DNS that applies to the whole VPC (T-92).

This sample is being built. The design is the contract:

- [Specification](design/agentic-untrusted-code-sandboxes.spec.md)
- [Decisions](adr/README.md)
- [Threat model](threat-model.md)
- [Runner wire protocol](runner/PROTOCOL.md)
- [Conventions for contributors and scripts](scripts/CONVENTIONS.md)

Build and test (Node.js 24, `aws-cdk-lib` 2.274.0):

```bash
npm ci
npx projen build
```
