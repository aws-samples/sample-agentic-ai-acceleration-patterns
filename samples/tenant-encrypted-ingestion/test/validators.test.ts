// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The test-switch validator (spec §10): accept, throw, pause and sleep,
 * driven by its SSM parameter.
 */

import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import { handler as testSwitch, PAUSE_SECONDS, pauseMillis } from '../src/validators/test-switch.function';

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
