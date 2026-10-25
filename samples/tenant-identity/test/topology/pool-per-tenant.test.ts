// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminInitiateAuthCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminSetUserPasswordCommand,
  CreateGroupCommand,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  DeleteUserPoolCommand,
  ListUsersCommand,
  ListUsersInGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import 'aws-sdk-client-mock-jest';
import { AnyMock, cognitoError, cognitoMock, depsFor, IDS, tenant } from './helpers';
import { ConflictError, NotFoundError, UnsupportedInTopologyError } from '../../src/shared/errors';
import { PoolPerTenantProvisioner } from '../../src/topology/pool-per-tenant';

const TRIGGER_ARN = 'arn:aws:lambda:eu-central-1:111122223333:function:trigger';
const POOL = 'eu-central-1_pool1';
const CLIENT = 'client1';

let cognito: AnyMock;
function provisioner(): PoolPerTenantProvisioner {
  return new PoolPerTenantProvisioner(depsFor(cognito, { triggerFunctionArn: TRIGGER_ARN, stackName: 'TenantIdentity-pool-per-tenant' }));
}
function tenantA() {
  return tenant({ tenantId: IDS.a, topology: 'pool-per-tenant', userPoolId: POOL, appClientId: CLIENT });
}

beforeEach(() => {
  cognito = cognitoMock();
});

describe('PoolPerTenantProvisioner (spec §7.1)', () => {
  describe('provisionTenant', () => {
    it('creates pool (ESSENTIALS, trigger, tag), client, and admin group, returns issuer (§7.1, N-8)', async () => {
      cognito.on(CreateUserPoolCommand).resolves({ UserPool: { Id: POOL } });
      cognito.on(CreateUserPoolClientCommand).resolves({ UserPoolClient: { ClientId: CLIENT } });
      cognito.on(CreateGroupCommand).resolves({});

      const result = await provisioner().provisionTenant(IDS.a, 'Tenant A');

      expect(result).toEqual({
        userPoolId: POOL,
        appClientId: CLIENT,
        issuer: `https://cognito-idp.eu-central-1.amazonaws.com/${POOL}`,
      });
      const poolInput = cognito.commandCalls(CreateUserPoolCommand)[0].args[0].input;
      expect(poolInput.UserPoolTier).toBe('ESSENTIALS');
      expect(poolInput.DeletionProtection).toBe('INACTIVE');
      // R-13 relies on this: with e-mail as the username attribute, the
      // Cognito username is the sub UUID the self-check compares against.
      expect(poolInput.UsernameAttributes).toEqual(['email']);
      expect(poolInput.AliasAttributes).toBeUndefined();
      // ADR-0026: the tenant tag the tenant-scoped role matches its session tag against.
      expect(poolInput.UserPoolTags).toEqual({
        'sample': 'tenant-identity',
        'tenant-identity:stack': 'TenantIdentity-pool-per-tenant',
        'tenant-identity:tenant': IDS.a,
      });
      expect(poolInput.Policies?.PasswordPolicy).toMatchObject({ MinimumLength: 12, RequireSymbols: true, TemporaryPasswordValidityDays: 1 });
      expect(poolInput.LambdaConfig.PreTokenGenerationConfig).toEqual({ LambdaVersion: 'V2_0', LambdaArn: TRIGGER_ARN });
      const clientInput = cognito.commandCalls(CreateUserPoolClientCommand)[0].args[0].input;
      expect(clientInput.ExplicitAuthFlows).toEqual(['ALLOW_ADMIN_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH']);
      expect(clientInput.AccessTokenValidity).toBe(5);
      expect(clientInput.PreventUserExistenceErrors).toBe('ENABLED');
      // R-17 (T-27): e-mail is immutable at the pool (an empty client
      // WriteAttributes would mean "all", so the pool schema is the guard).
      expect(poolInput.Schema).toEqual([{ Name: 'email', AttributeDataType: 'String', Required: true, Mutable: false }]);
      expect(clientInput.WriteAttributes).toBeUndefined();
      expect(clientInput.ReadAttributes).toEqual(['email']);
      // R-5, ADR-0009: refresh token rotation stays off.
      expect(clientInput.RefreshTokenRotation?.Feature ?? 'DISABLED').toBe('DISABLED');
      expect(cognito.commandCalls(CreateGroupCommand)[0].args[0].input.GroupName).toBe(`admin-${IDS.a}`);
    });

    it('deletes the half-built pool and rethrows when a later step fails (§7.1)', async () => {
      cognito.on(CreateUserPoolCommand).resolves({ UserPool: { Id: POOL } });
      cognito.on(CreateUserPoolClientCommand).rejects(new Error('boom'));
      cognito.on(DeleteUserPoolCommand).resolves({});
      await expect(provisioner().provisionTenant(IDS.a, 'Tenant A')).rejects.toThrow('boom');
      expect(cognito).toHaveReceivedCommandWith(DeleteUserPoolCommand as AnyMock, { UserPoolId: POOL });
    });
  });

  describe('deprovisionTenant', () => {
    it('deletes the pool (§7.1)', async () => {
      cognito.on(DeleteUserPoolCommand).resolves({});
      await provisioner().deprovisionTenant(tenantA());
      expect(cognito).toHaveReceivedCommandWith(DeleteUserPoolCommand as AnyMock, { UserPoolId: POOL });
    });

    it('treats ResourceNotFound as already gone (idempotent, P-4)', async () => {
      cognito.on(DeleteUserPoolCommand).rejects(cognitoError('ResourceNotFoundException'));
      await expect(provisioner().deprovisionTenant(tenantA())).resolves.toBeUndefined();
    });
  });

  describe('createUser', () => {
    it('creates a suppressed user and returns a temporary password; admin adds to admin group', async () => {
      cognito.on(AdminCreateUserCommand).resolves({ User: { Username: 'u1', Attributes: [{ Name: 'email', Value: 'u1@example.com' }], UserStatus: 'FORCE_CHANGE_PASSWORD' } });
      cognito.on(AdminAddUserToGroupCommand).resolves({});
      const result = await provisioner().createUser(tenantA(), 'u1@example.com', true);
      expect(result.temporaryPassword).toBeDefined();
      expect(result.user.email).toBe('u1@example.com');
      const createInput = cognito.commandCalls(AdminCreateUserCommand)[0].args[0].input;
      expect(createInput.MessageAction).toBe('SUPPRESS');
      expect(createInput.UserAttributes).toEqual(expect.arrayContaining([{ Name: 'email_verified', Value: 'true' }]));
      expect(cognito.commandCalls(AdminAddUserToGroupCommand)[0].args[0].input.GroupName).toBe(`admin-${IDS.a}`);
    });

    it('maps UsernameExistsException to ConflictError', async () => {
      cognito.on(AdminCreateUserCommand).rejects(cognitoError('UsernameExistsException'));
      await expect(provisioner().createUser(tenantA(), 'u1@example.com', false)).rejects.toBeInstanceOf(ConflictError);
    });

    it('never puts the temporary password in a log line', async () => {
      cognito.on(AdminCreateUserCommand).resolves({ User: { Username: 'u1' } });
      const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const result = await provisioner().createUser(tenantA(), 'u1@example.com', false);
      for (const line of spy.mock.calls.flat()) {
        expect(String(line)).not.toContain(result.temporaryPassword);
      }
      spy.mockRestore();
    });
  });

  describe('R-12 (user of another tenant)', () => {
    // In pool-per-tenant, another tenant's user does not exist in this pool.
    beforeEach(() => cognito.on(AdminGetUserCommand).rejects(cognitoError('UserNotFoundException')));

    it('deleteUser throws NotFoundError and sends no AdminDeleteUser', async () => {
      await expect(provisioner().deleteUser(tenantA(), 'foreign')).rejects.toBeInstanceOf(NotFoundError);
      expect(cognito).toHaveReceivedCommandTimes(AdminDeleteUserCommand as AnyMock, 0);
    });

    it('setAdmin throws NotFoundError and changes no group', async () => {
      await expect(provisioner().setAdmin(tenantA(), 'foreign', true)).rejects.toBeInstanceOf(NotFoundError);
      expect(cognito).toHaveReceivedCommandTimes(AdminAddUserToGroupCommand as AnyMock, 0);
    });

    it('issueToken throws NotFoundError and sets no password', async () => {
      await expect(provisioner().issueToken(tenantA(), 'foreign', 'pw')).rejects.toBeInstanceOf(NotFoundError);
      expect(cognito).toHaveReceivedCommandTimes(AdminSetUserPasswordCommand as AnyMock, 0);
    });

    it('refreshToken throws NotFoundError and never authenticates', async () => {
      await expect(provisioner().refreshToken(tenantA(), 'foreign', 'rt')).rejects.toBeInstanceOf(NotFoundError);
      expect(cognito).toHaveReceivedCommandTimes(AdminInitiateAuthCommand as AnyMock, 0);
    });
  });

  describe('getUser / listUsers', () => {
    it('getUser computes admin from group membership', async () => {
      cognito.on(AdminGetUserCommand).resolves({ Username: 'u1', UserAttributes: [{ Name: 'email', Value: 'u1@example.com' }], UserStatus: 'CONFIRMED', UserCreateDate: new Date() });
      cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: [{ GroupName: `admin-${IDS.a}` }] });
      const view = await provisioner().getUser(tenantA(), 'u1');
      expect(view.admin).toBe(true);
    });

    it('getUser returns Cognito\'s canonical username, not an e-mail from the path (R-13)', async () => {
      cognito.on(AdminGetUserCommand).resolves({ Username: 'sub-u1', UserAttributes: [{ Name: 'email', Value: 'u1@example.com' }], UserStatus: 'CONFIRMED' });
      cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: [] });
      const view = await provisioner().getUser(tenantA(), 'u1@example.com');
      expect(view.username).toBe('sub-u1');
    });

    it('listUsers maps users with admin flag from the admin group page', async () => {
      cognito.on(ListUsersInGroupCommand).resolves({ Users: [{ Username: 'u1' }] });
      cognito.on(ListUsersCommand).resolves({ Users: [{ Username: 'u1', Attributes: [{ Name: 'email', Value: 'u1@example.com' }] }, { Username: 'u2' }], PaginationToken: 'next' });
      const page = await provisioner().listUsers(tenantA());
      expect(page.items).toHaveLength(2);
      expect(page.items.find((u) => u.username === 'u1')?.admin).toBe(true);
      expect(page.items.find((u) => u.username === 'u2')?.admin).toBe(false);
      expect(page.nextToken).toBe('next');
    });
  });

  describe('token issuance', () => {
    beforeEach(() => cognito.on(AdminGetUserCommand).resolves({ Username: 'u1', UserAttributes: [], UserStatus: 'CONFIRMED' }));

    it('issueToken sets a permanent password then ADMIN_USER_PASSWORD_AUTH', async () => {
      cognito.on(AdminSetUserPasswordCommand).resolves({});
      cognito.on(AdminInitiateAuthCommand).resolves({ AuthenticationResult: { AccessToken: 'a', IdToken: 'i', RefreshToken: 'r', ExpiresIn: 300 } });
      const tokens = await provisioner().issueToken(tenantA(), 'u1', 'pw');
      expect(tokens).toEqual({ accessToken: 'a', idToken: 'i', refreshToken: 'r', expiresIn: 300 });
      expect(cognito.commandCalls(AdminSetUserPasswordCommand)[0].args[0].input.Permanent).toBe(true);
      expect(cognito.commandCalls(AdminInitiateAuthCommand)[0].args[0].input.AuthFlow).toBe('ADMIN_USER_PASSWORD_AUTH');
    });

    it('maps a trigger refusal (UserLambdaValidationException) to ConflictError with fixed text (P-2)', async () => {
      cognito.on(AdminSetUserPasswordCommand).resolves({});
      cognito.on(AdminInitiateAuthCommand).rejects(cognitoError('UserLambdaValidationException', 'secret cognito detail'));
      await expect(provisioner().issueToken(tenantA(), 'u1', 'pw')).rejects.toMatchObject({ name: 'ConflictError', message: 'Token issuance refused' });
    });

    it('refreshToken uses REFRESH_TOKEN_AUTH', async () => {
      cognito.on(AdminInitiateAuthCommand).resolves({ AuthenticationResult: { AccessToken: 'a', IdToken: 'i', ExpiresIn: 300 } });
      await provisioner().refreshToken(tenantA(), 'u1', 'rt');
      expect(cognito.commandCalls(AdminInitiateAuthCommand)[0].args[0].input.AuthFlow).toBe('REFRESH_TOKEN_AUTH');
    });
  });

  describe('membership ops are unsupported (P-4)', () => {
    it('createMembership throws UnsupportedInTopologyError', async () => {
      await expect(provisioner().createMembership(tenantA(), 'u1')).rejects.toBeInstanceOf(UnsupportedInTopologyError);
    });
    it('deleteMembership throws UnsupportedInTopologyError', async () => {
      await expect(provisioner().deleteMembership(tenantA(), 'u1')).rejects.toBeInstanceOf(UnsupportedInTopologyError);
    });
  });

  test('builds without triggerFunctionArn, and refuses only onboarding (tenant-user function)', async () => {
    const client = new CognitoIdentityProviderClient({});
    const p = new PoolPerTenantProvisioner({ cognito: client, region: 'eu-central-1' });
    await expect(p.provisionTenant('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'x')).rejects.toThrow(/triggerFunctionArn/);
  });

  test('refuses onboarding without stackName, before creating a pool (N-3)', async () => {
    const client = new CognitoIdentityProviderClient({});
    const p = new PoolPerTenantProvisioner({ cognito: client, region: 'eu-central-1', triggerFunctionArn: 'arn:aws:lambda:eu-central-1:123456789012:function:t' });
    await expect(p.provisionTenant('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'x')).rejects.toThrow(/stackName/);
  });

  describe('PROVISIONING tenant without pool fields (ADR-0021)', () => {
    const provisioning = () => tenant({ tenantId: IDS.a, topology: 'pool-per-tenant', status: 'PROVISIONING' });

    it('getUser throws ConflictError (409), not a plain Error (500)', async () => {
      await expect(provisioner().getUser(provisioning(), 'u1')).rejects.toBeInstanceOf(ConflictError);
      expect(cognito.calls()).toHaveLength(0);
    });

    it('listUsers throws ConflictError', async () => {
      await expect(provisioner().listUsers(provisioning())).rejects.toBeInstanceOf(ConflictError);
    });

    it('issueToken throws ConflictError when the app client is missing', async () => {
      cognito.on(AdminGetUserCommand).resolves({ Username: 'u1' });
      const noClient = tenant({ tenantId: IDS.a, topology: 'pool-per-tenant', userPoolId: POOL });
      await expect(provisioner().issueToken(noClient, 'u1', 'pw')).rejects.toBeInstanceOf(ConflictError);
      expect(cognito).toHaveReceivedCommandTimes(AdminSetUserPasswordCommand as AnyMock, 0);
    });
  });

  describe('assertEmailAvailable', () => {
    it('is a no-op: a new tenant has an empty pool', async () => {
      await expect(provisioner().assertEmailAvailable('u1@example.com')).resolves.toBeUndefined();
      expect(cognito.calls()).toHaveLength(0);
    });
  });

  describe('setAdmin happy path', () => {
    it('promote adds to admin-<tenant> in the tenant pool and returns admin=true', async () => {
      cognito.on(AdminGetUserCommand).resolves({ Username: 'u1', UserAttributes: [], UserStatus: 'CONFIRMED' });
      cognito.on(AdminAddUserToGroupCommand).resolves({});
      cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: [{ GroupName: `admin-${IDS.a}` }] });
      const view = await provisioner().setAdmin(tenantA(), 'u1', true);
      expect(cognito.commandCalls(AdminAddUserToGroupCommand)[0].args[0].input).toMatchObject({ UserPoolId: POOL, Username: 'u1', GroupName: `admin-${IDS.a}` });
      expect(view.admin).toBe(true);
    });

    it('demote removes from admin-<tenant> and returns admin=false', async () => {
      cognito.on(AdminGetUserCommand).resolves({ Username: 'u1', UserAttributes: [], UserStatus: 'CONFIRMED' });
      cognito.on(AdminRemoveUserFromGroupCommand).resolves({});
      cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: [] });
      const view = await provisioner().setAdmin(tenantA(), 'u1', false);
      expect(cognito.commandCalls(AdminRemoveUserFromGroupCommand)[0].args[0].input).toMatchObject({ UserPoolId: POOL, GroupName: `admin-${IDS.a}` });
      expect(view.admin).toBe(false);
    });
  });
});
