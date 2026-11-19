// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { GetParametersByPathCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import { CACHE_MAX_ENTRIES, CACHE_TTL_MS, HostsCheck, MAX_PAGES } from '../../src/demo-cell/hosts';

const ssm = mockClient(SSMClient);
const A = '01HZX8K9P0QRST7VWXYZ1A2B3C';

beforeEach(() => ssm.reset());

function check(clock: { t: number }) {
  return new HostsCheck('demo', { ssm: new SSMClient({ region: 'eu-central-1' }), now: () => clock.t });
}

describe('hosts check cache (spec §3.5)', () => {
  test('a refusal expires after the TTL, so a tenant deployed since is then hosted', async () => {
    ssm.on(GetParametersByPathCommand).resolvesOnce({ Parameters: [] }).resolves({ Parameters: [{ Name: 'p' }] });
    const clock = { t: 0 };
    const hosts = check(clock);
    expect(await hosts.hosts(A)).toBe(false);
    clock.t = CACHE_TTL_MS - 1;
    expect(await hosts.hosts(A)).toBe(false);
    clock.t = CACHE_TTL_MS;
    expect(await hosts.hosts(A)).toBe(true);
    expect(ssm.commandCalls(GetParametersByPathCommand)).toHaveLength(2);
  });

  test('keeps one entry per tenant, whatever the case of the claim', async () => {
    ssm.on(GetParametersByPathCommand).resolves({ Parameters: [{ Name: 'p' }] });
    const hosts = check({ t: 0 });
    await hosts.hosts(A);
    await hosts.hosts(A.toLowerCase());
    expect(ssm.commandCalls(GetParametersByPathCommand)).toHaveLength(1);
  });

  test('evicts the oldest entry at CACHE_MAX_ENTRIES', async () => {
    ssm.on(GetParametersByPathCommand).resolves({ Parameters: [{ Name: 'p' }] });
    const hosts = check({ t: 0 });
    for (let i = 0; i <= CACHE_MAX_ENTRIES; i++) {
      await hosts.hosts(`t${i}`);
    }
    expect(ssm.commandCalls(GetParametersByPathCommand)).toHaveLength(CACHE_MAX_ENTRIES + 1);
    await hosts.hosts(`t${CACHE_MAX_ENTRIES}`);
    expect(ssm.commandCalls(GetParametersByPathCommand)).toHaveLength(CACHE_MAX_ENTRIES + 1);
    await hosts.hosts('t0');
    expect(ssm.commandCalls(GetParametersByPathCommand)).toHaveLength(CACHE_MAX_ENTRIES + 2);
  });

  test('throws, and caches nothing, when every page is empty with a NextToken still set', async () => {
    ssm.on(GetParametersByPathCommand).resolves({ Parameters: [], NextToken: 'more' });
    const hosts = check({ t: 0 });
    await expect(hosts.hosts(A)).rejects.toThrow(/too many empty pages/);
    expect(ssm.commandCalls(GetParametersByPathCommand)).toHaveLength(MAX_PAGES);
    ssm.reset();
    ssm.on(GetParametersByPathCommand).resolves({ Parameters: [{ Name: 'p' }] });
    expect(await hosts.hosts(A)).toBe(true);
  });
});
