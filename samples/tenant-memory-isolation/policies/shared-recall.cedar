// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
permit (
    principal is AgentCore::OAuthUser,
    action in [
        AgentCore::Action::"tenant-memory___POST:/memories/{memoryId}/retrieve",
        AgentCore::Action::"tenant-memory___POST:/memories/{memoryId}/memoryRecords"
    ],
    resource == AgentCore::Gateway::"arn:aws:bedrock-agentcore:us-west-2:000000000000:gateway/example"
)
when {
    principal.hasTag("memory_namespace") &&
    context has input &&
    context.input has namespacePath &&
    context.input.namespacePath == principal.getTag("memory_namespace") &&
    !(context.input has namespace)
};
