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
    // Exactly one tenant's shared path: retrieval includes every namespace
    // under namespacePath, so a broader or deeper claim must not match.
    principal.getTag("memory_namespace") like "/tenants/*/shared/" &&
    !(principal.getTag("memory_namespace") like "/tenants/*/*/shared/") &&
    context has input &&
    context.input has namespacePath &&
    context.input.namespacePath == principal.getTag("memory_namespace") &&
    !(context.input has namespace)
};
