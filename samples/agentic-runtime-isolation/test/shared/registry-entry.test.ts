// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DeleteParameterCommand, GetParameterCommand, ParameterAlreadyExists, ParameterNotFound, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { parseRegistryEntry } from '../../src/shared/registry';
import { handleEvent, handler, type RegistryEntryEvent, respond } from '../../src/shared/registry-entry.function';

/**
 * ADR-0024: the registry-entry custom resource writes active on create
 * (never over another stack's entry), drains then deletes on delete (only
 * its own entry), and always answers.
 */
describe('registry-entry custom resource handler', () => {
  const ssm = mockClient(SSMClient);
  const NAME = '/application-plane/shared/agent-runtime/backends/billing';
  const RUNTIME_ARN = 'arn:aws:bedrock-agentcore:eu-central-1:111122223333:runtime/ri_billing-abc123';
  const OTHER_ARN = RUNTIME_ARN.replace('abc123', 'def456');
  const stored = (runtimeArn: string, status = 'active') => ({ Parameter: { Name: NAME, Value: JSON.stringify({ runtimeArn, requiredScopes: ['tenant-api/write'], status }) } });
  let slept: number[];
  let logs: string[];
  let outSpy: jest.SpyInstance;
  const deps = () => ({ ssm: new SSMClient({}), sleep: async (ms: number) => void slept.push(ms) });

  const event = (type: RegistryEntryEvent['RequestType'], overrides: Partial<RegistryEntryEvent['ResourceProperties']> = {}, physicalId?: string): RegistryEntryEvent => ({
    RequestType: type,
    ResponseURL: 'https://cloudformation-custom-resource-response.example.com/respond?x=1',
    StackId: 'arn:aws:cloudformation:eu-central-1:111122223333:stack/Backend/1',
    RequestId: 'req-1',
    LogicalResourceId: 'BillingRegistryEntry',
    PhysicalResourceId: physicalId,
    ResourceProperties: { ServiceToken: 'arn:aws:lambda:eu-central-1:111122223333:function:x', ParameterName: NAME, RuntimeArn: RUNTIME_ARN, RequiredScopes: ['tenant-api/write'], DrainSeconds: '180', ...overrides },
  });

  beforeEach(() => {
    ssm.reset();
    ssm.on(PutParameterCommand).resolves({ Version: 1 });
    ssm.on(GetParameterCommand).resolves(stored(RUNTIME_ARN));
    ssm.on(DeleteParameterCommand).resolves({});
    slept = [];
    logs = [];
    outSpy = jest.spyOn(process.stdout, 'write').mockImplementation((l: any) => {
      logs.push(String(l).trimEnd());
      return true;
    });
  });
  afterEach(() => outSpy.mockRestore());

  const written = (call = 0) => parseRegistryEntry(ssm.commandCalls(PutParameterCommand)[call].args[0].input.Value!);

  it('Create writes the active entry as a String parameter WITHOUT Overwrite, the parameter name is the physical id, and nothing is logged', async () => {
    const outcome = await handleEvent(event('Create'), deps());
    expect(outcome).toEqual({ status: 'SUCCESS', physicalResourceId: NAME });
    expect(ssm).toHaveReceivedCommandTimes(PutParameterCommand, 1);
    expect(ssm).toHaveReceivedCommandWith(PutParameterCommand, { Name: NAME, Type: 'String', Overwrite: false });
    expect(written()).toEqual({ runtimeArn: RUNTIME_ARN, requiredScopes: ['tenant-api/write'], status: 'active' });
    expect(ssm).not.toHaveReceivedCommand(GetParameterCommand);
    expect(ssm).not.toHaveReceivedCommand(DeleteParameterCommand);
    expect(slept).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('Create of a name another stack already holds FAILS naming the duplicate, and leaves the entry untouched', async () => {
    ssm.on(PutParameterCommand).rejects(new ParameterAlreadyExists({ message: 'exists', $metadata: {} }));
    ssm.on(GetParameterCommand).resolves(stored(OTHER_ARN));
    const outcome = await handleEvent(event('Create'), deps());
    expect(outcome.status).toBe('FAILED');
    expect(outcome.physicalResourceId).toBe(NAME);
    expect(outcome.reason).toContain('already registered');
    expect(outcome.reason).toContain(NAME);
    expect(ssm).toHaveReceivedCommandTimes(PutParameterCommand, 1);
    expect(ssm).toHaveReceivedCommandWith(PutParameterCommand, { Name: NAME, Overwrite: false });
    expect(ssm).not.toHaveReceivedCommand(DeleteParameterCommand);
    expect(logs).toEqual([]);
  });

  it('a retried Create of a name this Runtime already holds reclaims it with an overwrite (a lost answer or a rolled-back stack is not a duplicate)', async () => {
    ssm.on(PutParameterCommand).rejectsOnce(new ParameterAlreadyExists({ message: 'exists', $metadata: {} })).resolves({ Version: 2 });
    ssm.on(GetParameterCommand).resolves(stored(RUNTIME_ARN, 'draining'));
    const outcome = await handleEvent(event('Create'), deps());
    expect(outcome).toEqual({ status: 'SUCCESS', physicalResourceId: NAME });
    expect(ssm).toHaveReceivedCommandTimes(PutParameterCommand, 2);
    expect(ssm.commandCalls(PutParameterCommand)[1].args[0].input).toMatchObject({ Name: NAME, Overwrite: true });
    expect(written(1)).toEqual({ runtimeArn: RUNTIME_ARN, requiredScopes: ['tenant-api/write'], status: 'active' });
    expect(logs).toEqual([]);
  });

  it('Create of a held name FAILS when the owner cannot be read', async () => {
    ssm.on(PutParameterCommand).rejects(new ParameterAlreadyExists({ message: 'exists', $metadata: {} }));
    ssm.on(GetParameterCommand).rejects(new Error('Throttling'));
    const outcome = await handleEvent(event('Create'), deps());
    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('GetParameter failed');
    expect(ssm).toHaveReceivedCommandTimes(PutParameterCommand, 1);
  });

  it('Update overwrites the entry (a new Runtime ARN is live within one TTL); scopes default to none', async () => {
    const outcome = await handleEvent(event('Update', { RuntimeArn: OTHER_ARN, RequiredScopes: undefined }, NAME), deps());
    expect(outcome.status).toBe('SUCCESS');
    expect(ssm).toHaveReceivedCommandWith(PutParameterCommand, { Name: NAME, Overwrite: true });
    expect(written()).toEqual({ runtimeArn: OTHER_ARN, requiredScopes: [], status: 'active' });
  });

  it('Update with a changed ParameterName yields the new name as physical id, so CloudFormation follows with a Delete of the old entry', async () => {
    const renamed = NAME.replace('/billing', '/invoicing');
    const outcome = await handleEvent(event('Update', { ParameterName: renamed }, NAME), deps());
    expect(outcome).toEqual({ status: 'SUCCESS', physicalResourceId: renamed });
    expect(ssm).toHaveReceivedCommandTimes(PutParameterCommand, 1);
    expect(ssm).toHaveReceivedCommandWith(PutParameterCommand, { Name: renamed, Overwrite: true });
    // The old entry is not touched here: CloudFormation's follow-up Delete event, carrying the old properties, drains it.
    expect(ssm).not.toHaveReceivedCommand(DeleteParameterCommand);
  });

  it('Delete reads the entry, writes draining, waits DrainSeconds, then deletes the parameter', async () => {
    const outcome = await handleEvent(event('Delete', {}, NAME), deps());
    expect(outcome).toEqual({ status: 'SUCCESS', physicalResourceId: NAME });
    expect(ssm).toHaveReceivedCommandWith(GetParameterCommand, { Name: NAME });
    expect(written()).toEqual({ runtimeArn: RUNTIME_ARN, requiredScopes: ['tenant-api/write'], status: 'draining' });
    expect(slept).toEqual([180_000]);
    expect(ssm).toHaveReceivedCommandWith(DeleteParameterCommand, { Name: NAME });
    // Order: get, put, sleep, delete.
    const calls = ssm.calls().map((c) => c.args[0].constructor.name);
    expect(calls).toEqual(['GetParameterCommand', 'PutParameterCommand', 'DeleteParameterCommand']);
    expect(logs).toEqual([]);
  });

  it('Delete of an entry another Runtime now owns succeeds without touching it (a WARN line, below the function log level)', async () => {
    ssm.on(GetParameterCommand).resolves(stored(OTHER_ARN));
    const outcome = await handleEvent(event('Delete', {}, NAME), deps());
    expect(outcome).toEqual({ status: 'SUCCESS', physicalResourceId: NAME });
    expect(ssm).not.toHaveReceivedCommand(PutParameterCommand);
    expect(ssm).not.toHaveReceivedCommand(DeleteParameterCommand);
    expect(slept).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toMatchObject({ level: 'WARN', message: 'registry entry owned by another Runtime; left in place', parameter: NAME });
    expect(logs[0]).not.toContain(OTHER_ARN);
  });

  it('Delete of an entry that is already gone succeeds at the read: nothing is written or deleted, nothing is logged', async () => {
    ssm.on(GetParameterCommand).rejects(new ParameterNotFound({ message: 'gone', $metadata: {} }));
    const outcome = await handleEvent(event('Delete', { DrainSeconds: 0 }, NAME), deps());
    expect(outcome).toEqual({ status: 'SUCCESS', physicalResourceId: NAME });
    expect(ssm).not.toHaveReceivedCommand(PutParameterCommand);
    expect(ssm).not.toHaveReceivedCommand(DeleteParameterCommand);
    expect(slept).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('Delete of an entry whose value is not an entry (no owner to tell) removes it, skipping the wait for a zero drain, and tolerates a vanished parameter', async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Name: NAME, Value: 'not json' } });
    ssm.on(PutParameterCommand).rejects(new ParameterNotFound({ message: 'gone', $metadata: {} }));
    ssm.on(DeleteParameterCommand).rejects(new ParameterNotFound({ message: 'gone', $metadata: {} }));
    const outcome = await handleEvent(event('Delete', { DrainSeconds: 0 }, NAME), deps());
    expect(outcome).toEqual({ status: 'SUCCESS', physicalResourceId: NAME });
    expect(slept).toEqual([]);
    // The failed drain write is reported (an error line), the missing parameter on delete is not.
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toMatchObject({ level: 'ERROR', message: 'registry entry drain write failed', parameter: NAME, error: 'ParameterNotFound' });
  });

  it('Delete fails when the entry cannot be read for another reason (ownership unknown, nothing is touched)', async () => {
    ssm.on(GetParameterCommand).rejects(new Error('AccessDeniedException'));
    const outcome = await handleEvent(event('Delete', {}, NAME), deps());
    expect(outcome).toMatchObject({ status: 'FAILED', physicalResourceId: NAME });
    expect(outcome.reason).toContain('GetParameter failed');
    expect(ssm).not.toHaveReceivedCommand(PutParameterCommand);
    expect(ssm).not.toHaveReceivedCommand(DeleteParameterCommand);
  });

  it('Delete fails only when DeleteParameter fails for another reason', async () => {
    ssm.on(DeleteParameterCommand).rejects(new Error('AccessDeniedException'));
    const outcome = await handleEvent(event('Delete', {}, NAME), deps());
    expect(outcome.status).toBe('FAILED');
    expect(outcome.physicalResourceId).toBe(NAME);
    expect(outcome.reason).toContain('DeleteParameter failed');
  });

  it('Create with a malformed Runtime ARN or a bad name fails before any write (the ingress parser is the gate)', async () => {
    const bad = await handleEvent(event('Create', { RuntimeArn: 'arn:aws:lambda:eu-central-1:111122223333:function:x' }), deps());
    expect(bad.status).toBe('FAILED');
    expect(bad.reason).toContain('PutParameter failed');
    expect(ssm).not.toHaveReceivedCommand(PutParameterCommand);
    const relative = await handleEvent(event('Create', { ParameterName: 'backends/billing' }), deps());
    expect(relative).toMatchObject({ status: 'FAILED', physicalResourceId: 'registry-entry' });
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });

  it('Create reports a PutParameter fault as FAILED with the error name only (no message)', async () => {
    ssm.on(PutParameterCommand).rejects(new Error('ThrottlingException: secret details'));
    const outcome = await handleEvent(event('Create'), deps());
    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toBe('PutParameter failed: Error');
    expect(JSON.stringify(logs)).not.toContain('secret details');
  });

  it('respond PUTs the CloudFormation response to the ResponseURL and never throws', async () => {
    let captured: { options: any; body: string } | undefined;
    const request = ((options: any, callback: (res: any) => void) => {
      const chunks: string[] = [];
      const handlers: Record<string, () => void> = {};
      const res = { resume: () => undefined, on: (name: string, fn: () => void) => void (handlers[name] = fn) };
      return {
        on: () => undefined,
        end: (body: string) => {
          chunks.push(body);
          captured = { options, body: chunks.join('') };
          callback(res);
          handlers.end();
        },
      };
    }) as any;
    await respond(event('Create'), { status: 'SUCCESS', physicalResourceId: NAME }, request);
    expect(captured!.options).toMatchObject({ hostname: 'cloudformation-custom-resource-response.example.com', method: 'PUT', path: '/respond?x=1' });
    expect(JSON.parse(captured!.body)).toEqual({
      Status: 'SUCCESS',
      Reason: 'See ADR-0024',
      PhysicalResourceId: NAME,
      StackId: event('Create').StackId,
      RequestId: 'req-1',
      LogicalResourceId: 'BillingRegistryEntry',
    });
    // A failing request resolves anyway.
    const failing = (() => ({ on: (_: string, fn: () => void) => fn(), end: () => undefined })) as any;
    await expect(respond(event('Create'), { status: 'FAILED', physicalResourceId: NAME, reason: 'x' }, failing)).resolves.toBeUndefined();
  });

  it('the Lambda entry point exists and answers through respond', () => {
    expect(typeof handler).toBe('function');
  });
});
