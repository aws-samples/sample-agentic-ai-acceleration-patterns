// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { recheckDeps, resetAll, TODAY } from './support';
import { handleEvent, type SweeperStarterEvent } from '../../src/custom-resources/sweeper-starter.function';
import { SWEEPER_RECHECK_INPUT, SWEEPER_REMOVE_INPUT } from '../../src/shared/contracts';
import * as recheck from '../../src/sweeper/recheck';
import * as removal from '../../src/sweeper/removal';
import { createHandler, depsFromEnv, type SweeperDeps } from '../../src/sweeper/sweeper.function';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('sweeper entry (spec §3.1)', () => {
  const deps = { recheck: {}, removal: {} } as unknown as SweeperDeps;

  it('runs the removal job on the 15-minute input and the lister on the daily input', async () => {
    const remove = jest.spyOn(removal, 'runRemoval').mockResolvedValue({ disabled: 0, deletedTenants: 0, deletedCertificates: 0, disabledRouted: 0, failures: 0 });
    const lister = jest.spyOn(recheck, 'runLister').mockResolvedValue({ runDay: TODAY, entries: 0, pages: 0, missingPages: 0, deletedItems: 0 });
    const handler = createHandler(deps);
    await handler(JSON.parse(SWEEPER_REMOVE_INPUT));
    await handler(JSON.parse(SWEEPER_RECHECK_INPUT));
    expect(remove).toHaveBeenCalledTimes(1);
    expect(lister).toHaveBeenCalledTimes(1);
  });

  it('runs a page only on a well-formed page input', async () => {
    const runPage = jest.spyOn(recheck, 'runPage').mockResolvedValue({ stale: false, checked: 0, recorded: 0 });
    const handler = createHandler(deps);
    await handler({ job: 'page', runDay: TODAY, page: 1, tenantIds: [] });
    expect(runPage).toHaveBeenCalledTimes(1);
    await expect(handler({ job: 'page', runDay: 'today', page: 1, tenantIds: [] })).rejects.toThrow('not a sweeper page event');
  });

  it('refuses an unknown job', async () => {
    resetAll();
    await expect(createHandler(deps)({ job: 'drop-domain' })).rejects.toThrow('unknown sweeper job');
  });

  it('names the missing environment variable', () => {
    expect(() => depsFromEnv({ ROUTE_TABLE_ARN: recheckDeps().routeTableArn })).toThrow('missing environment variable DISTRIBUTION_ID');
    expect(() => depsFromEnv({ ROUTE_TABLE_ARN: recheckDeps().routeTableArn, DISTRIBUTION_ID: 'E1EXAMPLE0DIST' })).toThrow('missing environment variable SWEEPER_TABLE_NAME');
    expect(() => depsFromEnv({
      ROUTE_TABLE_ARN: recheckDeps().routeTableArn,
      DISTRIBUTION_ID: 'E1EXAMPLE0DIST',
      SWEEPER_TABLE_NAME: 'sweeper-table',
      AWS_LAMBDA_FUNCTION_NAME: 'tenant-front-door-sweeper',
    })).toThrow('missing environment variable POOLED_TENANT_ID');
  });

  it('builds its settings from the environment', () => {
    const built = depsFromEnv({
      ROUTE_TABLE_ARN: 'arn:aws:cloudfront::123456789012:key-value-store/11111111-2222-3333-4444-555555555555',
      SWEEPER_TABLE_NAME: 'sweeper-table',
      DISTRIBUTION_ID: 'E1EXAMPLE0DIST',
      POOLED_TENANT_ID: 'dt-pooled',
      AWS_LAMBDA_FUNCTION_NAME: 'tenant-front-door-sweeper',
      AWS_REGION: 'eu-central-1',
    });
    expect(built.recheck).toMatchObject({ tableName: 'sweeper-table', functionName: 'tenant-front-door-sweeper', distributionId: 'E1EXAMPLE0DIST' });
    expect(built.removal).toMatchObject({ distributionId: 'E1EXAMPLE0DIST', pooledTenantId: 'dt-pooled' });
  });
});

describe('starter custom resource (spec §3.4 step 5)', () => {
  const lambda = mockClient(LambdaClient);
  const event = (requestType: SweeperStarterEvent['RequestType'], name = 'tenant-front-door-sweeper'): SweeperStarterEvent => ({
    RequestType: requestType,
    ResponseURL: 'https://cloudformation-response.example.com/x',
    StackId: 'stack',
    RequestId: 'request',
    LogicalResourceId: 'SweeperStarter',
    ResourceProperties: { SweeperFunctionName: name },
  });
  const deps = { lambda: new LambdaClient({ region: 'eu-central-1' }) };

  beforeEach(() => {
    lambda.reset();
    lambda.on(InvokeCommand).resolves({ StatusCode: 202 });
  });

  it('starts one daily run asynchronously on Create, with the daily schedule\'s input', async () => {
    expect(await handleEvent(event('Create'), deps)).toEqual({ status: 'SUCCESS', physicalResourceId: 'sweeper-starter' });
    const calls = lambda.commandCalls(InvokeCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.FunctionName).toBe('tenant-front-door-sweeper');
    expect(calls[0].args[0].input.InvocationType).toBe('Event');
    expect(Buffer.from(calls[0].args[0].input.Payload as Uint8Array).toString('utf8')).toBe(SWEEPER_RECHECK_INPUT);
  });

  it.each(['Update', 'Delete'] as const)('does nothing on %s', async (type) => {
    expect((await handleEvent(event(type), deps)).status).toBe('SUCCESS');
    expect(lambda.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it('fails when the invoke is refused, naming only the error', async () => {
    lambda.on(InvokeCommand).rejects(Object.assign(new Error('not authorized for the function'), { name: 'AccessDeniedException' }));
    expect(await handleEvent(event('Create'), deps)).toEqual({
      status: 'FAILED', physicalResourceId: 'sweeper-starter', reason: 'sweeper invoke failed: AccessDeniedException',
    });
  });

  it('fails without a function name', async () => {
    expect((await handleEvent(event('Create', ''), deps)).status).toBe('FAILED');
  });
});
