// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { EntitlementContext, EntitlementServiceImpl } from '../../src/entitlements/entitlements';
import { type EntitlementHandlerDependencies, tenantAdminContext } from '../../src/entitlements/entitlements.function';
import { TokenVerifier } from '../../src/shared/verifier';
import { CLIENT_ID, DISCOVERY_URL, testIssuer, type TestIssuer } from '../helpers';

/**
 * The tenant-admin gate of the entitlement API (spec §5.3, C-14, ADR-0033):
 * the admin scope, then the tenant from the token (`tenant_id`, or
 * `X-Tenant-Id` among `tenants`), then credentials vended for that tenant.
 */
const ADMIN_SCOPE = 'entitlements/admin';

describe('tenantAdminContext', () => {
  let issuer: TestIssuer;
  let vended: Array<{ tenantId: string; sub: string }>;
  beforeAll(async () => {
    issuer = await testIssuer();
  });
  beforeEach(() => {
    vended = [];
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => jest.restoreAllMocks());

  const deps = (multiTenant = false): EntitlementHandlerDependencies => ({
    side: 'tenant-admin',
    service: {} as EntitlementServiceImpl,
    adminScope: ADMIN_SCOPE,
    verifier: new TokenVerifier(
      { discoveryUrl: DISCOVERY_URL, allowedClientIds: [CLIENT_ID], multiTenant },
      { getKey: issuer.getKey, fetchDiscovery: issuer.fetchDiscovery },
    ),
    tenantClient: async (tenantId, sub) => {
      vended.push({ tenantId, sub });
      return {} as DynamoDBDocumentClient;
    },
  });

  const event = (token: string, tenantHeader?: string): APIGatewayProxyEvent =>
    ({ headers: { Authorization: `Bearer ${token}`, ...(tenantHeader === undefined ? {} : { 'X-Tenant-Id': tenantHeader }) } }) as unknown as APIGatewayProxyEvent;

  const refusalOf = (result: EntitlementContext | APIGatewayProxyResult): { status: number; message: string } => {
    expect('statusCode' in result).toBe(true);
    const r = result as APIGatewayProxyResult;
    return { status: r.statusCode, message: JSON.parse(r.body).message };
  };

  it('403 admin_scope_missing without the entitlements/admin scope, and no credentials are vended', async () => {
    const token = await issuer.mint({ scope: 'app/use' });
    expect(refusalOf(await tenantAdminContext(event(token), deps()))).toEqual({ status: 403, message: 'forbidden: admin_scope_missing' });
    expect(vended).toEqual([]);
  });

  it('takes the tenant from the token\'s tenant_id and vends credentials for it', async () => {
    const token = await issuer.mint({ scope: `app/use ${ADMIN_SCOPE}` });
    const context = await tenantAdminContext(event(token), deps());
    expect(context).toMatchObject({ side: 'tenant-admin', tenantId: 'tenant-a', adminSub: 'user-a1' });
    expect(vended).toEqual([{ tenantId: 'tenant-a', sub: 'user-a1' }]);
  });

  it('takes the tenant from X-Tenant-Id when the token lists several tenants', async () => {
    const token = await issuer.mint({ scope: ADMIN_SCOPE, tenant_id: undefined, tenants: ['tenant-a', 'tenant-b'] });
    expect(await tenantAdminContext(event(token, 'tenant-b'), deps(true))).toMatchObject({ tenantId: 'tenant-b' });
    expect(vended).toEqual([{ tenantId: 'tenant-b', sub: 'user-a1' }]);
    expect(refusalOf(await tenantAdminContext(event(token), deps(true)))).toEqual({ status: 400, message: 'bad request: tenant_required' });
  });

  it('403 tenant_not_allowed for a header naming a tenant the token does not hold, single or multi', async () => {
    const single = await issuer.mint({ scope: ADMIN_SCOPE });
    expect(refusalOf(await tenantAdminContext(event(single, 'tenant-b'), deps()))).toEqual({ status: 403, message: 'forbidden: tenant_not_allowed' });
    const multi = await issuer.mint({ scope: ADMIN_SCOPE, tenant_id: undefined, tenants: ['tenant-a', 'tenant-b'] });
    expect(refusalOf(await tenantAdminContext(event(multi, 'tenant-c'), deps(true)))).toEqual({ status: 403, message: 'forbidden: tenant_not_allowed' });
    expect(vended).toEqual([]);
  });

  it('401 with no public reason for a missing or invalid token', async () => {
    const missing = { headers: {} } as unknown as APIGatewayProxyEvent;
    expect(refusalOf(await tenantAdminContext(missing, deps()))).toEqual({ status: 401, message: 'unauthorized' });
    expect(refusalOf(await tenantAdminContext(event(await issuer.mintForeign({ scope: ADMIN_SCOPE })), deps()))).toEqual({ status: 401, message: 'unauthorized' });
  });
});
