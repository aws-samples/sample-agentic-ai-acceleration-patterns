<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
A tenant user's identity token reaches the ingress, which mints a per-agent transaction token and passes it with tenant credentials to the agent in the AgentCore Runtime, the agent presents it to each tools gateway the token's `aud` names (`default` for the `crm` tools, `finance` for the `invoices` tools), each gateway's Policy engine admits the target and its REQUEST interceptor admits the one tool and signs a tenant context for that call, the `finance` gateway's RESPONSE filter trims `tools/list` to the tools the user holds, and the tool verifies that context and reads only that tenant's data.
