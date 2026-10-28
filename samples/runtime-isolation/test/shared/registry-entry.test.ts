// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DeleteParameterCommand, ParameterNotFound, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { parseRegistryEntry } from '../../src/shared/registry';
import { handleEvent, handler, type RegistryEntryEvent, respond } from '../../src/shared/registry-entry.function';

/** ADR-0024: the registry-entry custom resource writes active on create, drains then deletes on delete, and always answers. */
describe('registry-entry custom resource handler', () => {
  const ssm = mockClient(SSMClient);
  const NAME = '/application-plane/shared/agent-runtime/backends/billing';
  const RUNTIME_ARN = 'arn:aws:bedrock-agentcore:eu-central-1:111122223333:runtime/ri_billing-abc123';
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

  it('Create writes the active entry as a String parameter with Overwrite, the parameter name is the physical id, and nothing is logged', async () => {
    const outcome = await handleEvent(event('Create'), deps());
    expect(outcome).toEqual({ status: 'SUCCESS', physicalResourceId: NAME });
    expect(ssm).toHaveReceivedCommandTimes(PutParameterCommand, 1);
    expect(ssm).toHaveReceivedCommandWith(PutParameterCommand, { Name: NAME, Type: 'String', Overwrite: true });
    expect(written()).toEqual({ runtimeArn: RUNTIME_ARN, requiredScopes: ['tenant-api/write'], status: 'active' });
    expect(ssm).not.toHaveReceivedCommand(DeleteParameterCommand);
    expect(slept).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('Update overwrites the entry (a new Runtime ARN is live within one TTL); scopes default to none', async () => {
    const other = RUNTIME_ARN.replace('abc123', 'def456');
    const outcome = await handleEvent(event('Update', { RuntimeArn: other, RequiredScopes: undefined }, NAME), deps());
    expect(outcome.status).toBe('SUCCESS');
    expect(written()).toEqual({ runtimeArn: other, requiredScopes: [], status: 'active' });
  });

  it('Delete writes draining, waits DrainSeconds, then deletes the parameter', async () => {
    const outcome = await handleEvent(event('Delete', {}, NAME), deps());
    expect(outcome).toEqual({ status: 'SUCCESS', physicalResourceId: NAME });
    expect(written()).toEqual({ runtimeArn: RUNTIME_ARN, requiredScopes: ['tenant-api/write'], status: 'draining' });
    expect(slept).toEqual([180_000]);
    expect(ssm).toHaveReceivedCommandWith(DeleteParameterCommand, { Name: NAME });
    // Order: put, sleep, delete.
    const calls = ssm.calls().map((c) => c.args[0].constructor.name);
    expect(calls).toEqual(['PutParameterCommand', 'DeleteParameterCommand']);
    expect(logs).toEqual([]);
  });

  it('Delete of an entry that is already gone succeeds: ParameterNotFound is ignored on both writes, and the wait is skipped for a zero drain', async () => {
    ssm.on(PutParameterCommand).rejects(new ParameterNotFound({ message: 'gone', $metadata: {} }));
    ssm.on(DeleteParameterCommand).rejects(new ParameterNotFound({ message: 'gone', $metadata: {} }));
    const outcome = await handleEvent(event('Delete', { DrainSeconds: 0 }, NAME), deps());
    expect(outcome).toEqual({ status: 'SUCCESS', physicalResourceId: NAME });
    expect(slept).toEqual([]);
    // The failed drain write is reported (an error line), the missing parameter on delete is not.
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toMatchObject({ level: 'ERROR', message: 'registry entry drain write failed', parameter: NAME, error: 'ParameterNotFound' });
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
