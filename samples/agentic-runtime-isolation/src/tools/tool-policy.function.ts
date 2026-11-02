// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The `ToolTarget` policy custom resource (spec C-16, §3.6; ADR-0040). One
 * Cedar policy per target in the tools gateway's policy engine, with the
 * lifecycle spike V-14 showed the service needs:
 *
 * - Create: `CreatePolicy`, then wait for ACTIVE. Concurrent creates fail
 *   (53 of 98 ended `CREATE_FAILED` in V-14), so the construct chains every
 *   policy resource after the previous one, and this handler retries a
 *   failed or refused create with backoff, deleting a `CREATE_FAILED`
 *   policy before the next attempt.
 * - Update: `UpdatePolicy` with the current definition and wait for ACTIVE.
 *   Run on every target change, this is also the no-op touch for the known
 *   defect that denies tools added after a policy was written (C-16).
 * - Delete: `DeletePolicy`, then wait until `GetPolicy` says it is gone.
 *   The resource depends on the Gateway target, so CloudFormation deletes
 *   it, and this wait ends, BEFORE the target is deleted: an orphaned
 *   policy stops `tools/list` filtering for every caller (V-14).
 *
 * The policy text is never logged.
 */

import {
  BedrockAgentCoreControlClient,
  ConflictException,
  CreatePolicyCommand,
  DeletePolicyCommand,
  GetPolicyCommand,
  ResourceNotFoundException,
  ThrottlingException,
  UpdatePolicyCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { type CustomResourceEventBase, type CustomResourceOutcome, respond } from '../shared/cfn-response';
import { errorName, log } from '../shared/logger';

export interface ToolPolicyProperties {
  readonly PolicyEngineId: string;
  readonly Name: string;
  readonly Statement: string;
  /** `FAIL_ON_ANY_FINDINGS` (spec §7.1). */
  readonly ValidationMode?: string;
  /** Changes when the target's tools change, so the policy is touched (C-16). */
  readonly TargetVersion?: string;
  readonly ServiceToken?: string;
}

export interface ToolPolicyEvent extends CustomResourceEventBase {
  readonly RequestType: 'Create' | 'Update' | 'Delete';
  readonly PhysicalResourceId?: string;
  readonly ResourceProperties: ToolPolicyProperties;
  readonly OldResourceProperties?: ToolPolicyProperties;
}

export interface ToolPolicyDependencies {
  readonly client: Pick<BedrockAgentCoreControlClient, 'send'>;
  readonly sleep: (ms: number) => Promise<void>;
  /** Polls before giving up on a state change. */
  readonly maxPolls?: number;
  readonly pollMs?: number;
  readonly maxCreateAttempts?: number;
}

const DEFAULT_POLL_MS = 5000;
/** 14 minutes of 5 s polls: inside the 15-minute Lambda ceiling, above V-14's 90 s worst case. */
const DEFAULT_MAX_POLLS = 160;
const DEFAULT_CREATE_ATTEMPTS = 5;

function retryable(error: unknown): boolean {
  return error instanceof ConflictException || error instanceof ThrottlingException || (error as { $retryable?: unknown })?.$retryable !== undefined;
}

async function status(deps: ToolPolicyDependencies, engine: string, policyId: string): Promise<string | 'GONE'> {
  try {
    const out = await deps.client.send(new GetPolicyCommand({ policyEngineId: engine, policyId }));
    return out.status ?? 'UNKNOWN';
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      return 'GONE';
    }
    throw error;
  }
}

/** Polls until the policy reaches one of `wanted` or a failed state; returns the final state. */
async function waitFor(deps: ToolPolicyDependencies, engine: string, policyId: string, wanted: readonly string[]): Promise<string> {
  const maxPolls = deps.maxPolls ?? DEFAULT_MAX_POLLS;
  for (let i = 0; i < maxPolls; i++) {
    const current = await status(deps, engine, policyId);
    if (wanted.includes(current) || current.endsWith('_FAILED')) {
      return current;
    }
    await deps.sleep(deps.pollMs ?? DEFAULT_POLL_MS);
  }
  return 'TIMEOUT';
}

async function deleteAndWait(deps: ToolPolicyDependencies, engine: string, policyId: string): Promise<string> {
  try {
    await deps.client.send(new DeletePolicyCommand({ policyEngineId: engine, policyId }));
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      return 'GONE';
    }
    throw error;
  }
  return waitFor(deps, engine, policyId, ['GONE']);
}

async function create(deps: ToolPolicyDependencies, p: ToolPolicyProperties): Promise<CustomResourceOutcome> {
  const attempts = deps.maxCreateAttempts ?? DEFAULT_CREATE_ATTEMPTS;
  let lastReason = 'not attempted';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let policyId: string | undefined;
    try {
      const out = await deps.client.send(
        new CreatePolicyCommand({
          policyEngineId: p.PolicyEngineId,
          name: p.Name,
          definition: { cedar: { statement: p.Statement } },
          validationMode: (p.ValidationMode ?? 'FAIL_ON_ANY_FINDINGS') as never,
        }),
      );
      policyId = out.policyId;
    } catch (error) {
      lastReason = errorName(error);
      if (!retryable(error)) {
        return { status: 'FAILED', physicalResourceId: `policy:${p.Name}`, reason: `CreatePolicy failed: ${lastReason}` };
      }
    }
    if (policyId !== undefined) {
      const final = await waitFor(deps, p.PolicyEngineId, policyId, ['ACTIVE']);
      if (final === 'ACTIVE') {
        return { status: 'SUCCESS', physicalResourceId: policyId, data: { PolicyId: policyId } };
      }
      lastReason = final;
      // A CREATE_FAILED policy is removed before the next attempt (V-14).
      await deleteAndWait(deps, p.PolicyEngineId, policyId).catch(() => undefined);
    }
    await deps.sleep(Math.min(60_000, 2000 * 2 ** attempt));
  }
  return { status: 'FAILED', physicalResourceId: `policy:${p.Name}`, reason: `policy did not become ACTIVE: ${lastReason}` };
}

export async function handleEvent(event: ToolPolicyEvent, deps: ToolPolicyDependencies): Promise<CustomResourceOutcome> {
  const p = event.ResourceProperties;
  if (event.RequestType === 'Create') {
    return create(deps, p);
  }
  const policyId = event.PhysicalResourceId ?? '';
  if (event.RequestType === 'Delete') {
    if (!policyId.length || policyId.startsWith('policy:')) {
      return { status: 'SUCCESS', physicalResourceId: policyId || 'policy:none' };
    }
    const final = await deleteAndWait(deps, p.PolicyEngineId, policyId);
    return final === 'GONE'
      ? { status: 'SUCCESS', physicalResourceId: policyId }
      : { status: 'FAILED', physicalResourceId: policyId, reason: `policy not deleted: ${final}` };
  }
  // Update: a changed name or engine is a new policy (CloudFormation deletes the old one after).
  const old = event.OldResourceProperties;
  if (old !== undefined && (old.Name !== p.Name || old.PolicyEngineId !== p.PolicyEngineId)) {
    return create(deps, p);
  }
  // The definition, or the no-op touch with the same definition (C-16).
  await deps.client.send(
    new UpdatePolicyCommand({
      policyEngineId: p.PolicyEngineId,
      policyId,
      definition: { cedar: { statement: p.Statement } },
      validationMode: (p.ValidationMode ?? 'FAIL_ON_ANY_FINDINGS') as never,
    }),
  );
  const final = await waitFor(deps, p.PolicyEngineId, policyId, ['ACTIVE']);
  return final === 'ACTIVE'
    ? { status: 'SUCCESS', physicalResourceId: policyId, data: { PolicyId: policyId } }
    : { status: 'FAILED', physicalResourceId: policyId, reason: `policy update did not become ACTIVE: ${final}` };
}

const defaults: ToolPolicyDependencies = {
  client: new BedrockAgentCoreControlClient({}),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export const handler = async (event: ToolPolicyEvent): Promise<void> => {
  let outcome: CustomResourceOutcome;
  try {
    outcome = await handleEvent(event, defaults);
  } catch (error) {
    log.error('tool policy handler failed', { error: errorName(error) });
    outcome = { status: 'FAILED', physicalResourceId: event.PhysicalResourceId ?? 'policy:unknown', reason: errorName(error) };
  }
  await respond(event, outcome);
};
