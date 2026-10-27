// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Control-plane mounting scenario (mounting spec §10 steps 1-11). Run by
 * `scripts/integ-control-plane.sh` after it has deployed tenant-identity
 * (shared-pool), the setup stack and control-plane. Teardown (step 12) is the
 * script's exit trap, not this file.
 *
 * Everything here is what a consumer could do: control-plane's public API
 * with a vendor-IdP JWT, tenant-identity's platform API with SigV4, the
 * published SSM parameters, and stack outputs of the two stacks this test
 * owns. No control-plane `src/` is imported (sample-standard §5.2 forbids
 * another sample's `src/`); the only tenant-identity import is the shared
 * e2e client in `../clients`, which reads constants from this sample's own
 * `src/shared/constants`.
 *
 * Hygiene: no token, password or parameter value is ever printed.
 */

import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import * as path from 'path';
import { CloudFormationClient, DescribeStackResourcesCommand, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  AdminCreateUserCommand,
  AdminInitiateAuthCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { IAMClient, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam';
import { DescribeParametersCommand, GetParameterCommand, GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import { decodeClaims, HttpResult, PlatformClient, region } from '../clients';

const IDENTITY_NS = '/application-plane/shared/identity';
const SETUP_STACK = 'TenantIdentityCpSetup';
const CONTROL_PLANE_STACK = 'control-plane-dev';
const SAMPLE_DIR = path.resolve(__dirname, '../../..');

const cfn = new CloudFormationClient({ region: region() });
const ssm = new SSMClient({ region: region() });
const iam = new IAMClient({ region: region() });
const cognito = new CognitoIdentityProviderClient({ region: region() });

async function outputs(stack: string): Promise<Record<string, string>> {
  const res = await cfn.send(new DescribeStacksCommand({ StackName: stack }));
  const out: Record<string, string> = {};
  for (const o of res.Stacks?.[0]?.Outputs ?? []) {
    if (o.OutputKey !== undefined && o.OutputValue !== undefined) {
      out[o.OutputKey] = o.OutputValue;
    }
  }
  return out;
}

async function param(name: string): Promise<string> {
  const res = await ssm.send(new GetParameterCommand({ Name: name }));
  return res.Parameter!.Value!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Polls `probe` until it returns a value, or fails after `timeoutMs`. */
async function poll<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await probe();
      if (v !== undefined) return v;
    } catch (e) {
      last = e;
    }
    await sleep(15_000);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ''}`);
}

function expectStatus(res: HttpResult, status: number, what: string): void {
  if (res.status !== status) {
    // Status and error code only; bodies may carry a password.
    const code = (res.body as { code?: string; message?: string } | undefined)?.code ?? '';
    throw new Error(`${what}: expected HTTP ${status}, got ${res.status} ${code}`);
  }
}

/** control-plane's public API, called as the vendor operator. */
class ControlPlaneClient {
  constructor(private readonly apiUrl: string, private readonly idToken: string) {}

  async call<T = any>(method: string, route: string, body?: unknown): Promise<HttpResult<T>> {
    const res = await fetch(`${this.apiUrl.replace(/\/$/, '')}/${route}`, {
      method,
      headers: { 'Authorization': `Bearer ${this.idToken}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown;
    try { parsed = text === '' ? undefined : JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed as T };
  }
}

describe('control-plane mounts tenant-identity (mounting spec §10)', () => {
  const runId = randomBytes(3).toString('hex');
  const tenantName = `cp-mount-${runId}`;
  const adminEmail = `success+cp-admin-${runId}@simulator.amazonses.com`;

  let cp: ControlPlaneClient;
  let platform: PlatformClient;
  let keyArn: string;
  let tenantId: string;
  let cellId: string;
  let adminUsername: string;
  const parked = () => `/application-plane/tenants/${tenantId}/identity/admin-temporary-password`;

  beforeAll(async () => {
    const setup = await outputs(SETUP_STACK);
    const cpOut = await outputs(CONTROL_PLANE_STACK);
    platform = new PlatformClient(await param(`${IDENTITY_NS}/apiUrl`));
    keyArn = await param(`${IDENTITY_NS}/adminPasswordKeyArn`);

    // Mint an operator in the throwaway vendor IdP.
    const operator = `success+cp-operator-${runId}@simulator.amazonses.com`;
    const password = `${randomBytes(18).toString('base64url')}Aa1!`;
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId: setup.VendorIdpPoolId, Username: operator, MessageAction: 'SUPPRESS',
    }));
    await cognito.send(new AdminSetUserPasswordCommand({
      UserPoolId: setup.VendorIdpPoolId, Username: operator, Password: password, Permanent: true,
    }));
    const auth = await cognito.send(new AdminInitiateAuthCommand({
      UserPoolId: setup.VendorIdpPoolId,
      ClientId: setup.VendorIdpAudience,
      AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: operator, PASSWORD: password },
    }));
    cp = new ControlPlaneClient(cpOut.ApiUrl, auth.AuthenticationResult!.IdToken!);
  });

  test('steps 1-2: CreateTenant creates the cell and onboards the identity', async () => {
    const res = await cp.call('POST', 'tenants', { name: tenantName, adminEmail });
    expectStatus(res, 202, 'control-plane CreateTenant');
    tenantId = res.body.tenant.tenantId;
    cellId = res.body.tenant.cellId;

    const tenant = await poll('tenant ACTIVE', 30 * 60_000, async () => {
      const t = await cp.call('GET', `tenants/${tenantId}`);
      const status = t.body?.tenant?.status;
      if (status === 'CREATE_FAILED') throw new Error('tenant CREATE_FAILED; see the tenant CodeBuild log');
      return status === 'ACTIVE' ? t.body.tenant : undefined;
    });
    expect(tenant.cellId).toBe(cellId);

    // Step 1: the implicit cell ran cell/create.sh, which fails without the
    // identity parameters.
    const cell = await cp.call('GET', `cells/${cellId}`);
    expectStatus(cell, 200, 'GetCell');
    expect(cell.body.cell.status).toBe('ACTIVE');
  });

  test('step 3: tenant-identity holds the same tenant id', async () => {
    const res = await platform.call<any>('GET', `platform/tenants/${tenantId}`);
    expectStatus(res, 200, 'GetTenant');
    expect(res.body.tenant.status).toBe('ACTIVE');
    expect(res.body.tenant.name).toBe(tenantName);
  });

  test('step 4: exactly one user, the admin; no registry field leaks', async () => {
    const res = await platform.call<any>('GET', `platform/tenants/${tenantId}/users`);
    expectStatus(res, 200, 'ListUsers');
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0].admin).toBe(true);
    expect(res.body.users[0].email).toBe(adminEmail);
    adminUsername = res.body.users[0].username;

    const t = await platform.call<any>('GET', `platform/tenants/${tenantId}`);
    expect(t.body.tenant).not.toHaveProperty('firstAdminUsername');
  });

  test('step 5: the password is parked as a SecureString under AdminPasswordKey', async () => {
    const res = await ssm.send(new DescribeParametersCommand({
      ParameterFilters: [{ Key: 'Name', Values: [parked()] }],
    }));
    expect(res.Parameters).toHaveLength(1);
    expect(res.Parameters![0].Type).toBe('SecureString');
    const keyId = res.Parameters![0].KeyId!;
    expect(keyId === keyArn || keyArn.endsWith(`/${keyId}`) || keyArn.endsWith(keyId)).toBe(true);
  });

  test('step 5b: the tenant build role cannot decrypt the parked password', async () => {
    const res = await cfn.send(new DescribeStackResourcesCommand({ StackName: CONTROL_PLANE_STACK }));
    const roles = (res.StackResources ?? []).filter(
      (r) => r.ResourceType === 'AWS::IAM::Role' && /TenantProject.*Role/.test(r.LogicalResourceId ?? ''),
    );
    expect(roles).toHaveLength(1);
    const account = keyArn.split(':')[4];
    const partition = keyArn.split(':')[1];
    const roleArn = `arn:${partition}:iam::${account}:role/${roles[0].PhysicalResourceId}`;
    const sim = await iam.send(new SimulatePrincipalPolicyCommand({
      PolicySourceArn: roleArn, ActionNames: ['kms:Decrypt'], ResourceArns: [keyArn],
    }));
    expect(sim.EvaluationResults?.[0]?.EvalDecision).toBe('implicitDeny');
  });

  test('step 6: the admin signs in with the parked password; token names the tenant', async () => {
    const res = await ssm.send(new GetParameterCommand({ Name: parked(), WithDecryption: true }));
    const password = res.Parameter!.Value!;
    const issued = await platform.call<any>(
      'POST', `platform/tenants/${tenantId}/users/${adminUsername}/token`, { password },
    );
    if (issued.status === 404 || issued.status === 403) {
      throw new Error('IssueToken is not reachable: this test needs the test-aid routes deployed (ADR-0006)');
    }
    expectStatus(issued, 200, 'IssueToken');
    expect(decodeClaims(issued.body.accessToken).tenant_id).toBe(tenantId);
  });

  test('step 7: UpdateResource re-runs update.sh; nothing is re-written', async () => {
    const before = await ssm.send(new GetParameterCommand({ Name: parked() }));
    const res = await cp.call('PUT', `tenants/${tenantId}/resource`);
    expectStatus(res, 202, 'UpdateResource');
    await poll('tenant ACTIVE after update', 15 * 60_000, async () => {
      const t = await cp.call('GET', `tenants/${tenantId}`);
      const status = t.body?.tenant?.status;
      if (status === 'UPDATE_FAILED') throw new Error('tenant UPDATE_FAILED; see the tenant CodeBuild log');
      return status === 'ACTIVE' ? true : undefined;
    });
    const users = await platform.call<any>('GET', `platform/tenants/${tenantId}/users`);
    expect(users.body.users).toHaveLength(1);
    const after = await ssm.send(new GetParameterCommand({ Name: parked() }));
    expect(after.Parameter!.Version).toBe(before.Parameter!.Version);
  });

  test('step 8: re-running tenant/create.sh is a no-op', async () => {
    const before = await ssm.send(new GetParameterCommand({ Name: parked() }));
    const out = execFileSync('bash', [path.join(SAMPLE_DIR, 'scripts/control-plane/tenant/create.sh')], {
      env: {
        ...process.env,
        TENANT_ID: tenantId,
        TENANT_NAME: tenantName,
        CELL_ID: cellId,
        OPERATION: 'create',
        ADMIN_EMAIL: adminEmail,
        OPERATOR_ID: `integ-${runId}`,
        AWS_REGION: region(),
      },
      encoding: 'utf8',
    });
    expect(out).toContain('already has its first admin');
    const users = await platform.call<any>('GET', `platform/tenants/${tenantId}/users`);
    expect(users.body.users).toHaveLength(1);
    const after = await ssm.send(new GetParameterCommand({ Name: parked() }));
    expect(after.Parameter!.Version).toBe(before.Parameter!.Version);
  });

  test('step 9: CreateTenant with an existing tenantId is a 409', async () => {
    const res = await platform.call('POST', 'platform/tenants', { tenantId, name: 'other', adminEmail });
    expectStatus(res, 409, 'CreateTenant replay');
    const t = await platform.call<any>('GET', `platform/tenants/${tenantId}`);
    expect(t.body.tenant.name).toBe(tenantName);
  });

  test('step 9b: a second first admin is a 409; a second admin is fine', async () => {
    const email = `success+cp-second-${runId}@simulator.amazonses.com`;
    const first = await platform.call('POST', `platform/tenants/${tenantId}/users`, { email, firstAdmin: true });
    expectStatus(first, 409, 'CreateUser firstAdmin');
    const users = await platform.call<any>('GET', `platform/tenants/${tenantId}/users`);
    expect(users.body.users).toHaveLength(1);

    const second = await platform.call<any>('POST', `platform/tenants/${tenantId}/users`, { email, admin: true });
    expectStatus(second, 201, 'CreateUser admin');
    const del = await platform.call('DELETE', `platform/tenants/${tenantId}/users/${second.body.user.username}`);
    expect([200, 204]).toContain(del.status);
  });

  test('steps 10-11: DeleteTenant offboards the identity and the parked password', async () => {
    const res = await cp.call('DELETE', `tenants/${tenantId}`);
    expectStatus(res, 202, 'control-plane DeleteTenant');
    await poll('control-plane tenant gone', 15 * 60_000, async () => {
      const t = await cp.call('GET', `tenants/${tenantId}`);
      if (t.body?.tenant?.status === 'DELETE_FAILED') throw new Error('tenant DELETE_FAILED; see the tenant CodeBuild log');
      return t.status === 404 ? true : undefined;
    });
    await poll('tenant-identity tenant gone', 10 * 60_000, async () => {
      const t = await platform.call('GET', `platform/tenants/${tenantId}`);
      return t.status === 404 ? true : undefined;
    });
    const p = await ssm.send(new GetParametersCommand({ Names: [parked()] }));
    expect(p.InvalidParameters).toEqual([parked()]);

    // Leave the fleet empty so teardown has nothing to drain.
    const cell = await cp.call('DELETE', `cells/${cellId}`);
    expectStatus(cell, 202, 'DeleteCell');
    await poll('cell gone', 15 * 60_000, async () => {
      const c = await cp.call('GET', `cells/${cellId}`);
      return c.status === 404 ? true : undefined;
    });
  });
});
