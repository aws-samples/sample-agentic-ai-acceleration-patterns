// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  DeleteLogGroupCommand,
  PutDataProtectionPolicyCommand,
  PutRetentionPolicyCommand,
  ResourceAlreadyExistsException,
  ResourceNotFoundException,
} from '@aws-sdk/client-cloudwatch-logs';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { handleEvent, type RuntimeLogGroupEvent } from '../../src/backend/runtime-log-group.function';

const NAME = '/aws/bedrock-agentcore/runtimes/ri_abc-XYZ123-DEFAULT';
const POLICY = JSON.stringify({ Name: 'RuntimeIsolationHeaderValues', Version: '2021-06-01', Statement: [] });

function event(type: RuntimeLogGroupEvent['RequestType'], overrides: Partial<RuntimeLogGroupEvent['ResourceProperties']> = {}, physicalResourceId?: string): RuntimeLogGroupEvent {
  return {
    RequestType: type,
    ...(physicalResourceId !== undefined ? { PhysicalResourceId: physicalResourceId } : {}),
    ResponseURL: 'https://example.com/response',
    StackId: 'stack',
    RequestId: 'request',
    LogicalResourceId: 'LogGroup',
    ResourceProperties: { LogGroupName: NAME, RetentionInDays: '30', DataProtectionPolicy: POLICY, ...overrides },
  };
}

describe('the Runtime log group custom resource (T-18, M-12)', () => {
  const logs = mockClient(CloudWatchLogsClient);
  const client = new CloudWatchLogsClient({});
  beforeEach(() => logs.reset());

  it('Create: creates the group when the service has not yet, then puts retention and the policy; the group name is the physical id', async () => {
    logs.on(CreateLogGroupCommand).resolves({});
    logs.on(PutRetentionPolicyCommand).resolves({});
    logs.on(PutDataProtectionPolicyCommand).resolves({});
    const outcome = await handleEvent(event('Create'), client);
    expect(outcome).toEqual({ status: 'SUCCESS', physicalResourceId: NAME });
    expect(logs).toHaveReceivedCommandWith(CreateLogGroupCommand, { logGroupName: NAME });
    expect(logs).toHaveReceivedCommandWith(PutRetentionPolicyCommand, { logGroupName: NAME, retentionInDays: 30 });
    expect(logs).toHaveReceivedCommandWith(PutDataProtectionPolicyCommand, { logGroupIdentifier: NAME, policyDocument: POLICY });
  });

  it('Create: a group the service already made (the usual case) is settled, not an error', async () => {
    logs.on(CreateLogGroupCommand).rejects(new ResourceAlreadyExistsException({ message: 'exists', $metadata: {} }));
    logs.on(PutRetentionPolicyCommand).resolves({});
    logs.on(PutDataProtectionPolicyCommand).resolves({});
    const outcome = await handleEvent(event('Update'), client);
    expect(outcome.status).toBe('SUCCESS');
    expect(logs).toHaveReceivedCommandTimes(PutRetentionPolicyCommand, 1);
    expect(logs).toHaveReceivedCommandTimes(PutDataProtectionPolicyCommand, 1);
  });

  it('Create: any other failure fails the resource with the error name, and nothing is retried blindly', async () => {
    logs.on(CreateLogGroupCommand).resolves({});
    logs.on(PutRetentionPolicyCommand).resolves({});
    logs.on(PutDataProtectionPolicyCommand).rejects(Object.assign(new Error('bad regex'), { name: 'InvalidParameterException' }));
    const outcome = await handleEvent(event('Create'), client);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('InvalidParameterException');
    expect(outcome.physicalResourceId).toBe(NAME);
  });

  it('refuses a name outside the Runtime prefix, a bad retention and an empty policy before any call', async () => {
    for (const bad of [
      event('Create', { LogGroupName: '/aws/lambda/other' }),
      event('Create', { RetentionInDays: '0' }),
      event('Create', { DataProtectionPolicy: '' }),
    ]) {
      const outcome = await handleEvent(bad, client);
      expect(outcome.status).toBe('FAILED');
    }
    expect(logs).not.toHaveReceivedAnyCommand();
  });

  it('Delete: removes the group named by the PhysicalResourceId (the old name after a Runtime replacement); one already gone is success; another error fails', async () => {
    const OLD = '/aws/bedrock-agentcore/runtimes/ri_abc-OLD00000-DEFAULT';
    logs.on(DeleteLogGroupCommand).resolvesOnce({}).rejectsOnce(new ResourceNotFoundException({ message: 'gone', $metadata: {} })).rejectsOnce(Object.assign(new Error('nope'), { name: 'AccessDeniedException' }));
    expect(await handleEvent(event('Delete', {}, OLD), client)).toEqual({ status: 'SUCCESS', physicalResourceId: OLD });
    expect(logs).toHaveReceivedCommandWith(DeleteLogGroupCommand, { logGroupName: OLD });
    expect(await handleEvent(event('Delete', {}, NAME), client)).toEqual({ status: 'SUCCESS', physicalResourceId: NAME });
    const failed = await handleEvent(event('Delete', {}, NAME), client);
    expect(failed.status).toBe('FAILED');
    expect(failed.reason).toContain('AccessDeniedException');
    expect(logs).toHaveReceivedCommandTimes(DeleteLogGroupCommand, 3);
    expect(logs).not.toHaveReceivedCommand(PutDataProtectionPolicyCommand);
  });

  it('Delete of a resource whose Create failed validation (no Runtime group id) is success without a call', async () => {
    expect(await handleEvent(event('Delete', { LogGroupName: '/aws/lambda/other' }, 'runtime-log-group'), client)).toEqual({ status: 'SUCCESS', physicalResourceId: 'runtime-log-group' });
    expect(await handleEvent(event('Delete'), client)).toEqual({ status: 'SUCCESS', physicalResourceId: 'runtime-log-group' });
    expect(logs).not.toHaveReceivedAnyCommand();
  });
});
