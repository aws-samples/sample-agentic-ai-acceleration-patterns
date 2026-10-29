// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminInitiateAuthCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  CreateGroupCommand,
  DeleteGroupCommand,
  ListUsersCommand,
  ListUsersInGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import 'aws-sdk-client-mock-jest';
import { AnyMock, cognitoError, cognitoMock, depsFor, IDS, tenant } from './helpers';
import { ConflictError, InvalidInputError, NotFoundError, UnsupportedInTopologyError } from '../../src/shared/errors';
import { SharedPoolProvisioner } from '../../src/topology/shared-pool';

const POOL = 'eu-central-1_shared';
const CLIENT = 'sharedClient';
const TENANT_ATTR = 'custom:tenantId';

let cognito: AnyMock;
function provisioner(): SharedPoolProvisioner {
  return new SharedPoolProvisioner(depsFor(cognito, { sharedPool: { userPoolId: POOL, appClientId: CLIENT } }));
}
function tenantA() {
  return tenant({ tenantId: IDS.a, topology: 'shared-pool' });
}

beforeEach(() => {
  cognito = cognitoMock();
});

describe('SharedPoolProvisioner (spec §7.2)', () => {
  describe('provisionTenant', () => {
    it('creates t- and admin- groups idempotently (GroupExists is fine)', async () => {
      cognito.on(CreateGroupCommand).resolves({});
      const result = await provisioner().provisionTenant(IDS.a, 'Tenant A');
      expect(result).toEqual({});
      const names = cognito.commandCalls(CreateGroupCommand).map((c: AnyMock) => c.args[0].input.GroupName);
      expect(names).toEqual([`t-${IDS.a}`, `admin-${IDS.a}`]);
    });

    it('tolerates GroupExistsException', async () => {
      cognito.on(CreateGroupCommand).rejects(cognitoError('GroupExistsException'));
      await expect(provisioner().provisionTenant(IDS.a, 'Tenant A')).resolves.toEqual({});
    });
  });

  describe('createUser', () => {
    it('creates the user with custom:tenantId and adds to t- (+admin)', async () => {
      cognito.on(ListUsersCommand).resolves({ Users: [] }); // no existing e-mail
      cognito.on(AdminCreateUserCommand).resolves({ User: { Username: 'u1', Attributes: [{ Name: 'email', Value: 'u1@example.com' }, { Name: TENANT_ATTR, Value: IDS.a }] } });
      cognito.on(AdminAddUserToGroupCommand).resolves({});
      const result = await provisioner().createUser(tenantA(), 'u1@example.com', true);
      expect(result.temporaryPassword).toBeDefined();
      const attrs = cognito.commandCalls(AdminCreateUserCommand)[0].args[0].input.UserAttributes;
      expect(attrs).toEqual(expect.arrayContaining([{ Name: TENANT_ATTR, Value: IDS.a }]));
      const groups = cognito.commandCalls(AdminAddUserToGroupCommand).map((c: AnyMock) => c.args[0].input.GroupName);
      expect(groups).toEqual([`t-${IDS.a}`, `admin-${IDS.a}`]);
    });

    it('rejects an e-mail already in the pool with ConflictError (§5.3, §7.2)', async () => {
      // R-17 (T-27), T-27: only a verified existing e-mail is treated as present.
      cognito.on(ListUsersCommand).resolves({ Users: [{ Username: 'existing', Attributes: [{ Name: 'email', Value: 'u1@example.com' }, { Name: 'email_verified', Value: 'true' }] }] });
      await expect(provisioner().createUser(tenantA(), 'u1@example.com', false)).rejects.toBeInstanceOf(ConflictError);
      expect(cognito).toHaveReceivedCommandTimes(AdminCreateUserCommand as AnyMock, 0);
    });

    it('an unverified holder of the e-mail is a 409, never a reuse or a 500 (R-17)', async () => {
      // findUserByEmail ignores the unverified user, so AdminCreateUser runs
      // and Cognito refuses the alias: a conflict, not an internal error.
      cognito.on(ListUsersCommand).resolves({ Users: [{ Username: 'squatter', Attributes: [{ Name: 'email', Value: 'u1@example.com' }, { Name: 'email_verified', Value: 'false' }] }] });
      cognito.on(AdminCreateUserCommand).rejects(cognitoError('UsernameExistsException'));
      await expect(provisioner().createUser(tenantA(), 'u1@example.com', false)).rejects.toBeInstanceOf(ConflictError);
      expect(cognito).toHaveReceivedCommandTimes(AdminAddUserToGroupCommand as AnyMock, 0);
    });

    it('never logs the temporary password', async () => {
      cognito.on(ListUsersCommand).resolves({ Users: [] });
      cognito.on(AdminCreateUserCommand).resolves({ User: { Username: 'u1' } });
      cognito.on(AdminAddUserToGroupCommand).resolves({});
      const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const result = await provisioner().createUser(tenantA(), 'u1@example.com', false);
      for (const line of spy.mock.calls.flat()) {
        expect(String(line)).not.toContain(result.temporaryPassword);
      }
      spy.mockRestore();
    });
  });

  describe('R-12 (custom:tenantId mismatch)', () => {
    beforeEach(() => cognito.on(AdminGetUserCommand).resolves({ Username: 'u1', UserAttributes: [{ Name: TENANT_ATTR, Value: IDS.b }], UserStatus: 'CONFIRMED' }));

    it('assertMember throws NotFoundError on a different tenant', async () => {
      await expect(provisioner().assertMember(tenantA(), 'u2')).rejects.toBeInstanceOf(NotFoundError);
    });
    it('deleteUser changes nothing for a foreign user', async () => {
      await expect(provisioner().deleteUser(tenantA(), 'u2')).rejects.toBeInstanceOf(NotFoundError);
      expect(cognito).toHaveReceivedCommandTimes(AdminDeleteUserCommand as AnyMock, 0);
    });
    it('issueToken sets no password for a foreign user', async () => {
      await expect(provisioner().issueToken(tenantA(), 'u2', 'pw')).rejects.toBeInstanceOf(NotFoundError);
      expect(cognito).toHaveReceivedCommandTimes(AdminSetUserPasswordCommand as AnyMock, 0);
    });
  });

  describe('deprovisionTenant', () => {
    it('deletes group members and attribute-matched users, then both groups (idempotent)', async () => {
      // Group lists one user; a second attribute-matched user is missing from the group.
      cognito.on(ListUsersInGroupCommand).resolves({ Users: [{ Username: 'inGroup' }] });
      cognito.on(ListUsersCommand).resolves({
        Users: [
          { Username: 'inGroup', Attributes: [{ Name: TENANT_ATTR, Value: IDS.a }] },
          { Username: 'orphan', Attributes: [{ Name: TENANT_ATTR, Value: IDS.a }] },
          { Username: 'other', Attributes: [{ Name: TENANT_ATTR, Value: IDS.b }] },
        ],
      });
      cognito.on(AdminDeleteUserCommand).resolves({});
      cognito.on(DeleteGroupCommand).resolves({});
      await provisioner().deprovisionTenant(tenantA());
      const deleted = cognito.commandCalls(AdminDeleteUserCommand).map((c: AnyMock) => c.args[0].input.Username);
      expect(deleted.sort()).toEqual(['inGroup', 'orphan']);
      expect(deleted).not.toContain('other');
      const groups = cognito.commandCalls(DeleteGroupCommand).map((c: AnyMock) => c.args[0].input.GroupName);
      expect(groups).toEqual([`t-${IDS.a}`, `admin-${IDS.a}`]);
    });

    it('second run after partial failure is idempotent (ResourceNotFound ignored)', async () => {
      cognito.on(ListUsersInGroupCommand).resolves({ Users: [] });
      cognito.on(ListUsersCommand).resolves({ Users: [] });
      cognito.on(DeleteGroupCommand).rejects(cognitoError('ResourceNotFoundException'));
      await expect(provisioner().deprovisionTenant(tenantA())).resolves.toBeUndefined();
    });

    it('paginates ListUsersInGroup and ListUsers', async () => {
      cognito
        .on(ListUsersInGroupCommand)
        .resolvesOnce({ Users: [{ Username: 'g1' }], NextToken: 'p2' })
        .resolvesOnce({ Users: [{ Username: 'g2' }] });
      cognito
        .on(ListUsersCommand)
        .resolvesOnce({ Users: [{ Username: 'g1', Attributes: [{ Name: TENANT_ATTR, Value: IDS.a }] }], PaginationToken: 'p2' })
        .resolvesOnce({ Users: [{ Username: 'g2', Attributes: [{ Name: TENANT_ATTR, Value: IDS.a }] }] });
      cognito.on(AdminDeleteUserCommand).resolves({});
      cognito.on(DeleteGroupCommand).resolves({});
      await provisioner().deprovisionTenant(tenantA());
      expect(cognito).toHaveReceivedCommandTimes(ListUsersInGroupCommand as AnyMock, 2);
    });
  });

  describe('getUser / listUsers / setAdmin', () => {
    it('getUser returns admin from group membership for a matching tenant', async () => {
      cognito.on(AdminGetUserCommand).resolves({ Username: 'u1', UserAttributes: [{ Name: TENANT_ATTR, Value: IDS.a }, { Name: 'email', Value: 'u1@example.com' }], UserStatus: 'CONFIRMED', UserCreateDate: new Date() });
      cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: [{ GroupName: `admin-${IDS.a}` }] });
      const view = await provisioner().getUser(tenantA(), 'u1');
      expect(view.admin).toBe(true);
    });

    it('getUser returns Cognito\'s canonical username, not an e-mail from the path (R-13)', async () => {
      cognito.on(AdminGetUserCommand).resolves({ Username: 'sub-u1', UserAttributes: [{ Name: TENANT_ATTR, Value: IDS.a }], UserStatus: 'CONFIRMED' });
      cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: [] });
      const view = await provisioner().getUser(tenantA(), 'u1@example.com');
      expect(view.username).toBe('sub-u1');
    });

    it('getUser fails closed when Cognito returns no Username (R-13)', async () => {
      cognito.on(AdminGetUserCommand).resolves({ UserAttributes: [{ Name: TENANT_ATTR, Value: IDS.a }], UserStatus: 'CONFIRMED' });
      cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: [] });
      await expect(provisioner().getUser(tenantA(), 'u1@example.com')).rejects.toThrow('AdminGetUser returned no Username');
    });

    it('listUsers lists t- group members with admin flag', async () => {
      cognito.on(ListUsersInGroupCommand).callsFake((input: AnyMock) => {
        if (input.GroupName === `admin-${IDS.a}`) {
          return { Users: [{ Username: 'u1' }] };
        }
        return { Users: [{ Username: 'u1', Attributes: [{ Name: 'email', Value: 'u1@example.com' }] }, { Username: 'u2' }] };
      });
      const page = await provisioner().listUsers(tenantA());
      expect(page.items.find((u) => u.username === 'u1')?.admin).toBe(true);
      expect(page.items.find((u) => u.username === 'u2')?.admin).toBe(false);
    });
  });

  describe('membership ops unsupported (P-4)', () => {
    it('createMembership throws UnsupportedInTopologyError', async () => {
      await expect(provisioner().createMembership(tenantA(), 'u1')).rejects.toBeInstanceOf(UnsupportedInTopologyError);
    });
    it('deleteMembership throws UnsupportedInTopologyError', async () => {
      await expect(provisioner().deleteMembership(tenantA(), 'u1')).rejects.toBeInstanceOf(UnsupportedInTopologyError);
    });
  });

  describe('token issuance', () => {
    beforeEach(() => cognito.on(AdminGetUserCommand).resolves({ Username: 'u1', UserAttributes: [{ Name: TENANT_ATTR, Value: IDS.a }], UserStatus: 'CONFIRMED' }));
    it('issueToken signs in against the shared pool/client', async () => {
      cognito.on(AdminSetUserPasswordCommand).resolves({});
      cognito.on(AdminInitiateAuthCommand).resolves({ AuthenticationResult: { AccessToken: 'a', IdToken: 'i', RefreshToken: 'r', ExpiresIn: 300 } });
      const tokens = await provisioner().issueToken(tenantA(), 'u1', 'pw');
      expect(tokens.accessToken).toBe('a');
      expect(cognito.commandCalls(AdminInitiateAuthCommand)[0].args[0].input.ClientId).toBe(CLIENT);
    });
  });

  describe('assertEmailAvailable (spec §5.1 CreateTenant pre-flight)', () => {
    it('throws ConflictError when a verified user already holds the e-mail', async () => {
      cognito.on(ListUsersCommand).resolves({ Users: [{ Username: 'existing', Attributes: [{ Name: 'email', Value: 'u1@example.com' }, { Name: 'email_verified', Value: 'true' }] }] });
      await expect(provisioner().assertEmailAvailable('u1@example.com')).rejects.toBeInstanceOf(ConflictError);
      expect(cognito).toHaveReceivedCommandTimes(AdminCreateUserCommand as AnyMock, 0);
    });

    it('resolves when the e-mail is free', async () => {
      cognito.on(ListUsersCommand).resolves({ Users: [] });
      await expect(provisioner().assertEmailAvailable('free@example.com')).resolves.toBeUndefined();
    });
  });

  describe('getUser reads the user once', () => {
    it('reuses the R-12 AdminGetUser result instead of reading twice', async () => {
      cognito.on(AdminGetUserCommand).resolves({ Username: 'u1', UserAttributes: [{ Name: TENANT_ATTR, Value: IDS.a }], UserStatus: 'CONFIRMED' });
      cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: [] });
      await provisioner().getUser(tenantA(), 'u1');
      expect(cognito).toHaveReceivedCommandTimes(AdminGetUserCommand as AnyMock, 1);
    });
  });

  describe('setAdmin happy path', () => {
    beforeEach(() => cognito.on(AdminGetUserCommand).resolves({ Username: 'u1', UserAttributes: [{ Name: TENANT_ATTR, Value: IDS.a }], UserStatus: 'CONFIRMED' }));

    it('promote adds the user to admin-<tenant> and returns admin=true', async () => {
      cognito.on(AdminAddUserToGroupCommand).resolves({});
      cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: [{ GroupName: `t-${IDS.a}` }, { GroupName: `admin-${IDS.a}` }] });
      const view = await provisioner().setAdmin(tenantA(), 'u1', true);
      expect(cognito.commandCalls(AdminAddUserToGroupCommand)[0].args[0].input).toMatchObject({ UserPoolId: POOL, Username: 'u1', GroupName: `admin-${IDS.a}` });
      expect(view.admin).toBe(true);
    });

    it('demote removes the user from admin-<tenant> and returns admin=false', async () => {
      cognito.on(AdminRemoveUserFromGroupCommand).resolves({});
      cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: [{ GroupName: `t-${IDS.a}` }] });
      const view = await provisioner().setAdmin(tenantA(), 'u1', false);
      expect(cognito.commandCalls(AdminRemoveUserFromGroupCommand)[0].args[0].input).toMatchObject({ GroupName: `admin-${IDS.a}` });
      expect(view.admin).toBe(false);
    });
  });

  describe('setScopes / grantedScopes (ADR-0036)', () => {
    it('writes custom:scopes as a space-separated list after the R-12 check, and the view reads it back', async () => {
      cognito
        .on(AdminGetUserCommand)
        .resolvesOnce({ Username: 'u1', UserAttributes: [{ Name: TENANT_ATTR, Value: IDS.a }], UserStatus: 'CONFIRMED' })
        .resolves({ Username: 'u1', UserAttributes: [{ Name: TENANT_ATTR, Value: IDS.a }, { Name: 'custom:scopes', Value: 'sample/read' }], UserStatus: 'CONFIRMED' });
      cognito.on(AdminUpdateUserAttributesCommand).resolves({});
      cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: [] });
      const view = await provisioner().setScopes(tenantA(), 'u1', ['sample/read']);
      expect(cognito.commandCalls(AdminUpdateUserAttributesCommand)[0].args[0].input).toEqual({
        UserPoolId: POOL,
        Username: 'u1',
        UserAttributes: [{ Name: 'custom:scopes', Value: 'sample/read' }],
      });
      expect(view.grantedScopes).toEqual(['sample/read']);
    });

    it('an empty list writes the empty string (a present attribute: the user holds nothing)', async () => {
      cognito.on(AdminGetUserCommand).resolves({ Username: 'u1', UserAttributes: [{ Name: TENANT_ATTR, Value: IDS.a }, { Name: 'custom:scopes', Value: '' }], UserStatus: 'CONFIRMED' });
      cognito.on(AdminUpdateUserAttributesCommand).resolves({});
      cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: [] });
      const view = await provisioner().setScopes(tenantA(), 'u1', []);
      expect(cognito.commandCalls(AdminUpdateUserAttributesCommand)[0].args[0].input.UserAttributes).toEqual([{ Name: 'custom:scopes', Value: '' }]);
      expect(view.grantedScopes).toEqual([]);
    });

    it('a user of another tenant is a 404 and nothing is written (R-12)', async () => {
      cognito.on(AdminGetUserCommand).resolves({ Username: 'u2', UserAttributes: [{ Name: TENANT_ATTR, Value: IDS.b }], UserStatus: 'CONFIRMED' });
      await expect(provisioner().setScopes(tenantA(), 'u2', ['sample/read'])).rejects.toBeInstanceOf(NotFoundError);
      expect(cognito.commandCalls(AdminUpdateUserAttributesCommand)).toHaveLength(0);
    });

    it('a list that does not fit the 2048-character attribute is a 400, not a Cognito error', async () => {
      cognito.on(AdminGetUserCommand).resolves({ Username: 'u1', UserAttributes: [{ Name: TENANT_ATTR, Value: IDS.a }], UserStatus: 'CONFIRMED' });
      const many = Array.from({ length: 200 }, (_, i) => `backend-${i}/action-${i}`);
      await expect(provisioner().setScopes(tenantA(), 'u1', many)).rejects.toBeInstanceOf(InvalidInputError);
      expect(cognito.commandCalls(AdminUpdateUserAttributesCommand)).toHaveLength(0);
    });

    it('getUser reports an absent attribute as undefined (all of the tenant\'s scopes)', async () => {
      cognito.on(AdminGetUserCommand).resolves({ Username: 'u1', UserAttributes: [{ Name: TENANT_ATTR, Value: IDS.a }], UserStatus: 'CONFIRMED' });
      cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: [] });
      expect((await provisioner().getUser(tenantA(), 'u1')).grantedScopes).toBeUndefined();
    });
  });
});
