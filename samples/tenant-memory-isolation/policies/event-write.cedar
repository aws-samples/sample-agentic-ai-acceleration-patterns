// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
permit (
    principal is AgentCore::OAuthUser,
    action == AgentCore::Action::"tenant-memory___POST:/memories/{memoryId}/events",
    resource == AgentCore::Gateway::"arn:aws:bedrock-agentcore:us-west-2:000000000000:gateway/example"
)
when {
    principal.hasTag("memory_actor") && principal.hasTag("memory_session") &&
    // One path segment: an actor such as "tenant-a/shared/x" would extract into
    // a namespace nested under tenant-a's shared facts.
    !(principal.getTag("memory_actor") like "*/*") &&
    !(principal.getTag("memory_actor") like "*:*") &&
    context has input &&
    context.input has actorId && context.input has sessionId &&
    context.input.actorId == principal.getTag("memory_actor") &&
    context.input.sessionId == principal.getTag("memory_session") &&
    !(context.input has extractionConfig)
};
