// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CreatePolicyCommand, DeletePolicyCommand, GetPolicyCommand, ResourceNotFoundException, UpdatePolicyCommand } from '@aws-sdk/client-bedrock-agentcore-control';
import { cedarPolicyFor } from '../../src/shared/cedar';
import { handleEvent, type ToolPolicyDependencies, type ToolPolicyEvent } from '../../src/tools/tool-policy.function';

/** The ToolTarget policy custom resource (C-16, ADR-0040, ADR-0041). */
const GATEWAY_ARN = 'arn:aws:bedrock-agentcore:eu-central-1:111122223333:gateway/ri-default-abc123';
const props = { PolicyEngineId: 'engine-1', Name: 'crm_target', Statement: cedarPolicyFor('crm', GATEWAY_ARN), ValidationMode: 'FAIL_ON_ANY_FINDINGS' };

function event(RequestType: ToolPolicyEvent['RequestType'], extra: Partial<ToolPolicyEvent> = {}): ToolPolicyEvent {
  return {
    RequestType,
    ResponseURL: 'https://example.com',
    StackId: 'arn:aws:cloudformation:eu-central-1:111122223333:stack/s/1',
    RequestId: 'r',
    LogicalResourceId: 'Policy',
    ResourceProperties: props,
    ...extra,
  } as ToolPolicyEvent;
}

/** A fake control-plane client: statuses per GetPolicy call, in order. */
function deps(statuses: string[], options: { createFails?: number } = {}) {
  const sent: string[] = [];
  let clock = 0;
  let creates = 0;
  const client = {
    send: async (command: unknown) => {
      sent.push((command as object).constructor.name);
      clock += 1500;
      if (command instanceof CreatePolicyCommand) {
        creates += 1;
        return { policyId: `p-${creates}` };
      }
      if (command instanceof GetPolicyCommand) {
        const next = statuses.shift();
        if (next === 'GONE') {
          throw new ResourceNotFoundException({ message: 'gone', $metadata: {} });
        }
        // 'STATUS:reason' carries the service's statusReasons.
        const [status, reason] = (next ?? 'ACTIVE').split(':');
        return { status, statusReasons: reason === undefined ? [] : [reason] };
      }
      return {};
    },
  };
  const d: ToolPolicyDependencies = {
    client,
    sleep: async () => undefined,
    now: () => clock,
    maxPolls: 10,
    maxCreateAttempts: (options.createFails ?? 0) + 1,
  };
  return { d, sent };
}

describe('tool policy handler', () => {
  it('Create waits for ACTIVE and returns PolicyId and SecondsToActive (integ step 23)', async () => {
    const { d, sent } = deps(['CREATING', 'CREATING', 'ACTIVE']);
    const outcome = await handleEvent(event('Create'), d);
    expect(outcome).toMatchObject({ status: 'SUCCESS', physicalResourceId: 'p-1', data: { PolicyId: 'p-1' } });
    expect(Number(outcome.data!.SecondsToActive)).toBeCloseTo(6, 1);
    expect(sent).toEqual(['CreatePolicyCommand', 'GetPolicyCommand', 'GetPolicyCommand', 'GetPolicyCommand']);
  });

  it('a CREATE_FAILED policy is deleted before the next attempt', async () => {
    const { d, sent } = deps(['CREATE_FAILED', 'CREATE_FAILED', 'GONE', 'ACTIVE'], { createFails: 1 });
    const outcome = await handleEvent(event('Create'), d);
    expect(outcome).toMatchObject({ status: 'SUCCESS', physicalResourceId: 'p-2' });
    expect(sent).toContain(DeletePolicyCommand.name);
  });

  it('a policy that never becomes ACTIVE fails with the service statusReasons', async () => {
    const reason = 'Insufficient permissions to call gateway with ID g-1';
    const { d } = deps([`CREATE_FAILED:${reason}`, `CREATE_FAILED:${reason}`, 'GONE']);
    const outcome = await handleEvent(event('Create'), d);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toBe(`policy did not become ACTIVE: CREATE_FAILED (${reason})`);
  });

  it('Update touches the policy and reports SecondsToActive', async () => {
    const { d, sent } = deps(['UPDATING', 'ACTIVE']);
    const outcome = await handleEvent(event('Update', { PhysicalResourceId: 'p-9', OldResourceProperties: props }), d);
    expect(outcome).toMatchObject({ status: 'SUCCESS', data: { PolicyId: 'p-9' } });
    expect(outcome.data!.SecondsToActive).toBeDefined();
    expect(sent[0]).toBe(UpdatePolicyCommand.name);
  });

  it('Delete of a failed Create (the id CloudFormation generated) calls nothing', async () => {
    const { d, sent } = deps([]);
    expect(await handleEvent(event('Delete', { PhysicalResourceId: 's-Policy-163XEPIF4PYQL' }), d)).toMatchObject({ status: 'SUCCESS' });
    expect(sent).toEqual([]);
  });

  it('Delete waits until the policy is gone (ADR-0040: before its target)', async () => {
    const { d, sent } = deps(['DELETING', 'GONE']);
    expect(await handleEvent(event('Delete', { PhysicalResourceId: 'p-3' }), d)).toMatchObject({ status: 'SUCCESS' });
    expect(sent).toEqual(['DeletePolicyCommand', 'GetPolicyCommand', 'GetPolicyCommand']);
  });
});

describe('statement bound (M-83, red team 2026-11-04)', () => {
  it('refuses any Statement that is not the star permit of one target, before calling the engine', async () => {
    for (const Statement of ['permit(principal, action, resource);', 'forbid(principal, action, resource);', cedarPolicyFor('crm', GATEWAY_ARN).replace('permit(', 'forbid('), 42]) {
      const ev = { RequestType: 'Create', ResponseURL: 'https://example.com', StackId: 's', RequestId: 'r', LogicalResourceId: 'P', ResourceProperties: { ...props, Statement } } as any;
      const outcome = await handleEvent(ev, { client: { send: async () => { throw new Error('engine must not be called'); } } as any });
      expect(outcome.status).toBe('FAILED');
      expect(outcome.reason).toMatch(/Statement/);
    }
  });
});
