<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
A tenant user's identity token reaches the ingress, which mints a per-agent transaction token and passes it to the agent in the AgentCore Runtime, the agent presents it to the tools gateway, the gateway's interceptor signs a tenant context for the one tool call, and the tool verifies that context and reads only that tenant's data.
