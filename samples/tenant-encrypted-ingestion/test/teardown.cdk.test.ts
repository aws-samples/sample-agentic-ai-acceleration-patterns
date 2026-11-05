// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Teardown order (spec §6.2, M-26) and the test-switch validator (spec §10).
 *
 * The key drain runs on stack delete only after CloudFormation removed the
 * API and every function that can create or use a key: each of those
 * depends on the drain, and CloudFormation deletes dependents first.
 */

import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import { logicalIdOf, synthConstruct } from './helpers';
import { handler as testSwitch, PAUSE_SECONDS, pauseMillis } from '../src/validators/test-switch.function';

describe('stack-delete order (M-26)', () => {
  const { template } = synthConstruct();
  const drainId = logicalIdOf(template, 'Custom::TenantKeyDrain', '/Ingestion/KeyDrain/Default');
  const dependsOn = (type: string, path: string) => (template.toJSON().Resources[logicalIdOf(template, type, path)].DependsOn ?? []) as string[];

  it.each([
    ['AWS::ApiGateway::RestApi', '/Ingestion/Api/Resource'],
    ['AWS::Lambda::Function', '/Ingestion/KeyFactoryFunction/Resource'],
    ['AWS::Lambda::Function', '/Ingestion/PlatformFunction/Resource'],
    ['AWS::Lambda::Function', '/Ingestion/ProcessorFunction/Resource'],
    ['AWS::Lambda::Function', '/Ingestion/SweepFunction/Resource'],
  ])('%s %s is removed before the drain runs', (type, path) => {
    expect(dependsOn(type, path)).toContain(drainId);
  });

  it('the drain runs under platformRole', () => {
    const fn = template.toJSON().Resources[logicalIdOf(template, 'AWS::Lambda::Function', '/Ingestion/KeyDrainFunction/Resource')];
    expect(fn.Properties.Role['Fn::GetAtt'][0]).toBe(logicalIdOf(template, 'AWS::IAM::Role', '/Ingestion/PlatformRole/Resource'));
  });
});

describe('test-switch validator', () => {
  const ssm = mockClient(SSMClient);
  const context = { getRemainingTimeInMillis: () => 10 };
  beforeEach(() => {
    ssm.reset();
    process.env.TEI_TEST_SWITCH_PARAMETER = '/test/switch';
  });

  it('accepts in mode accept and for an unknown mode', async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: 'accept' } });
    expect(await testSwitch({}, context)).toEqual({ version: '1', verdict: 'ACCEPT' });
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: 'surprise' } });
    expect(await testSwitch({}, context)).toEqual({ version: '1', verdict: 'ACCEPT' });
  });

  it('throws in mode throw (a validator error)', async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: 'throw' } });
    await expect(testSwitch({}, context)).rejects.toThrow(/throw/);
  });

  it('pauses for PAUSE_SECONDS, or the seconds of pause:<n>, capped below the remaining time', async () => {
    expect(pauseMillis('pause', 600_000)).toBe(PAUSE_SECONDS * 1000);
    expect(pauseMillis('pause:150', 600_000)).toBe(150_000);
    expect(pauseMillis('pause:150', 60_000)).toBe(59_000);
    expect(pauseMillis('pause:x', 600_000)).toBeUndefined();
    expect(pauseMillis('sleep', 600_000)).toBeUndefined();
    jest.useFakeTimers();
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: 'pause:5' } });
    const pending = testSwitch({}, { getRemainingTimeInMillis: () => 60_000 });
    await jest.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toEqual({ version: '1', verdict: 'ACCEPT' });
    jest.useRealTimers();
  });

  it('sleeps past its remaining time in mode sleep', async () => {
    jest.useFakeTimers();
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: 'sleep' } });
    const pending = testSwitch({}, context);
    await jest.advanceTimersByTimeAsync(1010);
    await expect(pending).resolves.toEqual({ version: '1', verdict: 'ACCEPT' });
    jest.useRealTimers();
  });
});
