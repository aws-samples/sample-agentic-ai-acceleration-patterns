<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Runtime Isolation

A backend that trusts exactly one ingress, which maps the validated caller to
an isolated compute unit (Amazon Bedrock AgentCore Runtime first), with
optional session mapping, scope checks, delegation and a token vending machine.

This README is a placeholder written by the implementation stage; the
documentation stage replaces it with the sections of
[`docs/sample-standard.md`](../../docs/sample-standard.md) §7. Until then, the
design trail is the reference:

- [`design/runtime-isolation.spec.md`](./design/runtime-isolation.spec.md)
- [`adr/`](./adr/README.md)
- [`threat-model.md`](./threat-model.md)

Build: `npx projen build`. The construct is `IsolatedRuntime`, exported from
[`src/index.ts`](./src/index.ts); the demo stack is
[`src/main.ts`](./src/main.ts) (`--context ingress=api-gateway|agentcore-gateway`).
