// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The `agentcore` backend: AgentCore Runtime V2 sessions (spec §3.4, ADR-0009).
 *
 * Stub from the scaffold (ADR-0025). The agentcore backend worker owns this file
 * and replaces every method; nothing else in src/ may depend on its
 * internals, only on {@link SandboxBackend}.
 */

import type {
  ReadyResult, RegistryRow, RunJob, RunOutcome, SandboxBackend, SandboxHandle, SandboxSummary,
  StopFacts, TenantCredentials,
} from '../backend';

function notBuilt(method: string): never {
  throw new Error(`agentcore backend: ${method} is not built yet`);
}

export class AgentcoreBackend implements SandboxBackend {
  public readonly name = 'agentcore' as const;
  public readonly startCapMs = 30_000;

  /** Reads its settings from the function environment the construct sets (BackendConstruct.environment). */
  public constructor(public readonly env: Readonly<Record<string, string | undefined>> = process.env) {}

  public async start(_tenantId: string, _nonce: string, _creds: TenantCredentials): Promise<SandboxHandle> {
    return notBuilt('start');
  }

  public async ready(_handle: SandboxHandle, _row: RegistryRow): Promise<ReadyResult> {
    return notBuilt('ready');
  }

  public async run(_handle: SandboxHandle, _job: RunJob): Promise<RunOutcome> {
    return notBuilt('run');
  }

  public async stop(_handle: SandboxHandle, _creds?: TenantCredentials): Promise<void> {
    return notBuilt('stop');
  }

  public list(): AsyncIterable<SandboxSummary> {
    return notBuilt('list');
  }

  public async isAlive(_handle: SandboxHandle): Promise<boolean> {
    return notBuilt('isAlive');
  }

  public async stopReason(_handle: SandboxHandle): Promise<StopFacts> {
    return notBuilt('stopReason');
  }
}
