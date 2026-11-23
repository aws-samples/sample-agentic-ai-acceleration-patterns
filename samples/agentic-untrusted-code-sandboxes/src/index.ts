// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The core entry (spec §3.3). Nothing reachable from here imports
// agentic-runtime-isolation (ADR-0017): a lint rule and
// test/import-graph.test.ts enforce it.

export * from './backend';
export * from './backend-construct';
export * from './props';
export * from './untrusted-code-sandboxes.cdk';
export { MicrovmBackend } from './backends/microvm';
export { NitroBackend } from './backends/nitro';
export { AgentcoreBackend } from './backends/agentcore';
export {
  PROTOCOL_VERSION, type RunJob, type RunResult, type Refusal, type RefusalCode, type HelloRequest,
  type HelloResponse, type PingResponse, type RunHookPayload, type JobResponse,
} from './protocol';
export { handlerEntry, runnerPath, HANDLERS } from './handler-entry';
export { runCode } from './tool/run-code';
export {
  isRunCodeError, type RunCodeRequest, type RunCodeOutput, type RunCodeError, type RunCodeResult, type ToolErrorCode,
} from './tool/types';
export { offboardTenant, type OffboardResult } from './offboard/offboard';
