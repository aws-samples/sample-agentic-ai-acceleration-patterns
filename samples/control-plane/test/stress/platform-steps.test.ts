// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FleetEnv } from './fleet';
import { type Manifest, parseManifest } from './manifest';
import { hookCommitOf, hookPolicyFile, parseFrontDoor, readFrontDoor, setHookPolicy, warmUp } from './platform-steps';

const DIST = 'arn:aws:cloudfront::123456789012:distribution/E2EXAMPLE12345';
const POLICY = 'arn:aws:iam::123456789012:policy/tenant-front-door-route-hook-stress';
const good = { edgeUrl: 'https://stress.example.com', registrarUrl: 'https://abcde12345.execute-api.eu-west-2.amazonaws.com/v1/', distributionArn: DIST, hookPolicyArn: POLICY };

describe('the front-door manifest the control plane reads', () => {
  it('reads the edge, the distribution and the hook policy', () => {
    expect(parseFrontDoor(JSON.stringify(good), 'f')).toMatchObject({ edgeUrl: 'https://stress.example.com', distributionArn: DIST, hookPolicyArn: POLICY, agentBackend: 'default' });
  });
  it('accepts a first phase without the optional fields and names a wrong one', () => {
    expect(parseFrontDoor(JSON.stringify({ ...good, distributionArn: undefined, hookPolicyArn: undefined }), 'f').distributionArn).toBeUndefined();
    expect(() => parseFrontDoor(JSON.stringify({ ...good, distributionArn: 'x' }), 'f')).toThrow(/distributionArn/);
    expect(() => parseFrontDoor(JSON.stringify({ ...good, hookPolicyArn: 'x' }), 'f')).toThrow(/hookPolicyArn/);
    expect(() => parseFrontDoor(undefined, 'f')).toThrow(/tenant-front-door slice writes/);
  });
  it('returns undefined when the front door is not in the run', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-fd-'));
    expect(readFrontDoor(home, 'p')).toBeUndefined();
    fs.mkdirSync(path.join(home, 'p'));
    fs.writeFileSync(path.join(home, 'p', 'tenant-front-door.json'), JSON.stringify(good));
    expect(readFrontDoor(home, 'p')?.hookPolicyArn).toBe(POLICY);
  });
});

describe('the warm-up step', () => {
  it('refuses a cell account with no ingress reader role before it places anything', async () => {
    const findings: string[] = [];
    const api = { call: jest.fn() };
    const env = {
      api,
      rec: { finding: (t: string) => findings.push(t) },
      cellAccounts: [{ label: 'cell-account-1', accountId: '111111111111', profile: 'p', accountBaseStackArns: [] }],
      log: () => undefined,
    } as unknown as FleetEnv;
    const manifest = { seeded: ['01KAF5M0000000000000000T01'], churn: [], extra: [] } as unknown as Manifest;
    expect(await warmUp(env, manifest, () => undefined)).toBeUndefined();
    expect(findings.join()).toMatch(/no ingressReaderRoleArn/);
    expect(api.call).not.toHaveBeenCalled();
  });
});

describe('the hook policy file and the hook commit', () => {
  it('writes the policy for the control-plane deploys and removes it', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-hook-'));
    setHookPolicy(home, 'p', POLICY);
    expect(fs.readFileSync(hookPolicyFile(home, 'p'), 'utf8')).toBe(`${POLICY}\n`);
    expect((fs.statSync(hookPolicyFile(home, 'p')).mode % 0o1000).toString(8)).toBe('600');
    setHookPolicy(home, 'p', undefined);
    expect(fs.existsSync(hookPolicyFile(home, 'p'))).toBe(false);
    expect(() => setHookPolicy(home, 'p', 'not an arn')).toThrow(/IAM policy ARN/);
  });
  it('wants a full commit SHA', () => {
    expect(hookCommitOf('a'.repeat(40))).toBe('a'.repeat(40));
    expect(() => hookCommitOf('abc123')).toThrow(/STRESS_HOOK_COMMIT/);
    expect(() => hookCommitOf(undefined)).toThrow(/STRESS_HOOK_COMMIT/);
  });
});

describe('the control-plane manifest with identity and warm-up', () => {
  const base = { version: 1, prefix: 'p', tier: 'small', commit: 'abc', seeded: ['01KAF5M0000000000000000T01'], churn: [], extra: [] };
  const user = { username: 'u', email: 'e@example.com' };
  it('keeps identity[] and warmUp when they are well formed', () => {
    const m = parseManifest(JSON.stringify({ ...base, identity: [{ tenantId: '01KAF5M0000000000000000T01', admin: user, users: [user] }], warmUp: { tenantId: '01KAF5M0000000000000000T01', cellId: 'c', accountId: '1', cellApiDomain: 'd', ingressParameter: 'i' } }), 'f');
    expect(m.identity).toHaveLength(1);
    expect(m.warmUp?.cellId).toBe('c');
  });
  it('refuses a malformed identity entry or warm-up record', () => {
    expect(() => parseManifest(JSON.stringify({ ...base, identity: [{ tenantId: 'x', admin: user, users: [] }] }), 'f')).toThrow(/identity must list/);
    expect(() => parseManifest(JSON.stringify({ ...base, warmUp: { tenantId: 'x' } }), 'f')).toThrow(/warmUp must name/);
  });
});
