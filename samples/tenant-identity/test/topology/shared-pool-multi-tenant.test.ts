// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminUpdateUserAttributesCommand,
  CreateGroupCommand,
  DeleteGroupCommand,
  ListUsersCommand,
  ListUsersInGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import 'aws-sdk-client-mock-jest';
import { AnyMock, cognitoError, cognitoMock, depsFor, IDS, tenant } from './helpers';
import { ConflictError, NotFoundError } from '../../src/shared/errors';
import { SharedPoolMultiTenantProvisioner } from '../../src/topology/shared-pool-multi-tenant';

const POOL = 'eu-central-1_multi';
const CLIENT = 'multiClient';

let cognito: AnyMock;
function provisioner(): SharedPoolMultiTenantProvisioner {
  return new SharedPoolMultiTenantProvisioner(depsFor(cognito, { sharedPool: { userPoolId: POOL, appClientId: CLIENT } }));
}
function tenantA() {
  return tenant({ tenantId: IDS.a, topology: 'shared-pool-multi-tenant', groupName: `t-${IDS.a}` });
}
/** Convenience: make AdminListGroupsForUser return the given group names. */
function userGroups(...names: string[]) {
  cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: names.map((n) => ({ GroupName: n })) });
}

beforeEach(() => {
  cognito = cognitoMock();
});

describe('SharedPoolMultiTenantProvisioner (spec §7.3)', () => {
  describe('provisionTenant', () => {
    it('creates t- (name as description) and admin- groups, returns groupName', async () => {
      cognito.on(CreateGroupCommand).resolves({});
      const result = await provisioner().provisionTenant(IDS.a, 'Tenant A');
      expect(result).toEqual({ groupName: `t-${IDS.a}` });
      const calls = cognito.commandCalls(CreateGroupCommand).map((c: AnyMock) => c.args[0].input);
      expect(calls[0]).toMatchObject({ GroupName: `t-${IDS.a}`, Description: 'Tenant A' });
      expect(calls[1]).toMatchObject({ GroupName: `admin-${IDS.a}` });
    });
  });

  describe('createUser', () => {
    it('creates a new user and adds to t- (+admin), returns a password', async () => {
      cognito.on(ListUsersCommand).resolves({ Users: [] });
      cognito.on(AdminCreateUserCommand).resolves({ User: { Username: 'u1', Attributes: [{ Name: 'email', Value: 'u1@example.com' }] } });
      cognito.on(AdminAddUserToGroupCommand).resolves({});
      const result = await provisioner().createUser(tenantA(), 'u1@example.com', true);
      expect(result.temporaryPassword).toBeDefined();
      const groups = cognito.commandCalls(AdminAddUserToGroupCommand).map((c: AnyMock) => c.args[0].input.GroupName);
      expect(groups).toEqual([`t-${IDS.a}`, `admin-${IDS.a}`]);
    });

    it('an unverified holder of the e-mail is a 409: no membership for a squatter (R-17)', async () => {
      cognito.on(ListUsersCommand).resolves({ Users: [{ Username: 'squatter', Attributes: [{ Name: 'email', Value: 'u1@example.com' }, { Name: 'email_verified', Value: 'false' }] }] });
      cognito.on(AdminCreateUserCommand).rejects(cognitoError('UsernameExistsException'));
      await expect(provisioner().createUser(tenantA(), 'u1@example.com', true)).rejects.toBeInstanceOf(ConflictError);
      expect(cognito).toHaveReceivedCommandTimes(AdminAddUserToGroupCommand as AnyMock, 0);
    });

    it('reuses an existing e-mail user and returns no password (T-21)', async () => {
      // R-17 (T-27), T-27: only a verified existing e-mail is reused.
      cognito.on(ListUsersCommand).resolves({ Users: [{ Username: 'existing', Attributes: [{ Name: 'email', Value: 'u1@example.com' }, { Name: 'email_verified', Value: 'true' }] }] });
      cognito.on(AdminAddUserToGroupCommand).resolves({});
      userGroups(`t-${IDS.a}`);
      const result = await provisioner().createUser(tenantA(), 'u1@example.com', false);
      expect(result.temporaryPassword).toBeUndefined();
      expect(cognito).toHaveReceivedCommandTimes(AdminCreateUserCommand as AnyMock, 0);
      expect(cognito.commandCalls(AdminAddUserToGroupCommand)[0].args[0].input.GroupName).toBe(`t-${IDS.a}`);
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

  describe('R-12 (user not in t-<tenant>)', () => {
    beforeEach(() => userGroups(`t-${IDS.b}`)); // user is only in tenant B

    it('deleteUser changes nothing for a foreign user', async () => {
      await expect(provisioner().deleteUser(tenantA(), 'u2')).rejects.toBeInstanceOf(NotFoundError);
      expect(cognito).toHaveReceivedCommandTimes(AdminRemoveUserFromGroupCommand as AnyMock, 0);
      expect(cognito).toHaveReceivedCommandTimes(AdminDeleteUserCommand as AnyMock, 0);
    });
    it('deleteMembership changes nothing for a foreign user', async () => {
      await expect(provisioner().deleteMembership(tenantA(), 'u2')).rejects.toBeInstanceOf(NotFoundError);
      expect(cognito).toHaveReceivedCommandTimes(AdminRemoveUserFromGroupCommand as AnyMock, 0);
    });
    it('setAdmin changes nothing for a foreign user', async () => {
      await expect(provisioner().setAdmin(tenantA(), 'u2', true)).rejects.toBeInstanceOf(NotFoundError);
      expect(cognito).toHaveReceivedCommandTimes(AdminAddUserToGroupCommand as AnyMock, 0);
    });
  });

  describe('membership ops', () => {
    it('createMembership requires the user to exist, then adds idempotently', async () => {
      cognito.on(AdminGetUserCommand).resolves({ Username: 'u1', UserAttributes: [], UserStatus: 'CONFIRMED' });
      cognito.on(AdminAddUserToGroupCommand).resolves({});
      await provisioner().createMembership(tenantA(), 'u1');
      expect(cognito.commandCalls(AdminAddUserToGroupCommand)[0].args[0].input.GroupName).toBe(`t-${IDS.a}`);
    });

    it('createMembership throws NotFoundError when the user does not exist', async () => {
      cognito.on(AdminGetUserCommand).rejects(cognitoError('UserNotFoundException'));
      await expect(provisioner().createMembership(tenantA(), 'ghost')).rejects.toBeInstanceOf(NotFoundError);
      expect(cognito).toHaveReceivedCommandTimes(AdminAddUserToGroupCommand as AnyMock, 0);
    });

    it('deleteMembership on the user last tenant throws ConflictError (§5.1)', async () => {
      userGroups(`t-${IDS.a}`); // only tenant A
      await expect(provisioner().deleteMembership(tenantA(), 'u1')).rejects.toBeInstanceOf(ConflictError);
      expect(cognito).toHaveReceivedCommandTimes(AdminRemoveUserFromGroupCommand as AnyMock, 0);
    });

    it('deleteMembership removes t- and admin- when another tenant remains', async () => {
      userGroups(`t-${IDS.a}`, `t-${IDS.b}`);
      cognito.on(AdminRemoveUserFromGroupCommand).resolves({});
      await provisioner().deleteMembership(tenantA(), 'u1');
      const removed = cognito.commandCalls(AdminRemoveUserFromGroupCommand).map((c: AnyMock) => c.args[0].input.GroupName);
      expect(removed).toEqual([`t-${IDS.a}`, `admin-${IDS.a}`]);
    });
  });

  describe('deleteUser', () => {
    it('removes groups and deletes the user when no t- group remains', async () => {
      // assertMember sees A; after removal, listGroupsForUser returns none.
      cognito
        .on(AdminListGroupsForUserCommand)
        .resolvesOnce({ Groups: [{ GroupName: `t-${IDS.a}` }] }) // assertMember
        .resolves({ Groups: [] }); // after removal
      cognito.on(AdminRemoveUserFromGroupCommand).resolves({});
      cognito.on(AdminDeleteUserCommand).resolves({});
      await provisioner().deleteUser(tenantA(), 'u1');
      expect(cognito).toHaveReceivedCommandTimes(AdminDeleteUserCommand as AnyMock, 1);
    });

    it('keeps the user when another t- group remains', async () => {
      cognito
        .on(AdminListGroupsForUserCommand)
        .resolvesOnce({ Groups: [{ GroupName: `t-${IDS.a}` }, { GroupName: `t-${IDS.b}` }] })
        .resolves({ Groups: [{ GroupName: `t-${IDS.b}` }] });
      cognito.on(AdminRemoveUserFromGroupCommand).resolves({});
      await provisioner().deleteUser(tenantA(), 'u1');
      expect(cognito).toHaveReceivedCommandTimes(AdminDeleteUserCommand as AnyMock, 0);
    });
  });

  describe('deprovisionTenant', () => {
    it('deletes single-tenant users, unlinks multi-tenant users, then both groups', async () => {
      cognito.on(ListUsersInGroupCommand).resolves({ Users: [{ Username: 'solo' }, { Username: 'multi' }] });
      cognito.on(AdminListGroupsForUserCommand).callsFake((input: AnyMock) => {
        if (input.Username === 'solo') {
          return { Groups: [{ GroupName: `t-${IDS.a}` }] };
        }
        return { Groups: [{ GroupName: `t-${IDS.a}` }, { GroupName: `t-${IDS.b}` }] };
      });
      cognito.on(AdminDeleteUserCommand).resolves({});
      cognito.on(AdminRemoveUserFromGroupCommand).resolves({});
      cognito.on(DeleteGroupCommand).resolves({});
      await provisioner().deprovisionTenant(tenantA());
      expect(cognito.commandCalls(AdminDeleteUserCommand).map((c: AnyMock) => c.args[0].input.Username)).toEqual(['solo']);
      const removed = cognito.commandCalls(AdminRemoveUserFromGroupCommand).map((c: AnyMock) => c.args[0].input.Username);
      expect(removed).toContain('multi');
      expect(cognito.commandCalls(DeleteGroupCommand).map((c: AnyMock) => c.args[0].input.GroupName)).toEqual([`t-${IDS.a}`, `admin-${IDS.a}`]);
    });

    it('second run after partial failure is idempotent (empty group, missing groups ignored)', async () => {
      cognito.on(ListUsersInGroupCommand).resolves({ Users: [] });
      cognito.on(DeleteGroupCommand).rejects(cognitoError('ResourceNotFoundException'));
      await expect(provisioner().deprovisionTenant(tenantA())).resolves.toBeUndefined();
    });

    it('paginates ListUsersInGroup', async () => {
      cognito
        .on(ListUsersInGroupCommand)
        .resolvesOnce({ Users: [{ Username: 'a' }], NextToken: 'p2' })
        .resolvesOnce({ Users: [{ Username: 'b' }] });
      userGroups(`t-${IDS.a}`);
      cognito.on(AdminDeleteUserCommand).resolves({});
      cognito.on(DeleteGroupCommand).resolves({});
      await provisioner().deprovisionTenant(tenantA());
      expect(cognito).toHaveReceivedCommandTimes(ListUsersInGroupCommand as AnyMock, 2);
    });
  });

  describe('assertMember / getUser', () => {
    it('assertMember passes when the user is in t-<tenant>', async () => {
      userGroups(`t-${IDS.a}`);
      await expect(provisioner().assertMember(tenantA(), 'u1')).resolves.toBeUndefined();
    });

    it('getUser computes admin from admin-<tenant> membership', async () => {
      userGroups(`t-${IDS.a}`, `admin-${IDS.a}`);
      cognito.on(AdminGetUserCommand).resolves({ Username: 'u1', UserAttributes: [{ Name: 'email', Value: 'u1@example.com' }], UserStatus: 'CONFIRMED', UserCreateDate: new Date() });
      const view = await provisioner().getUser(tenantA(), 'u1');
      expect(view.admin).toBe(true);
    });

    it('getUser returns Cognito\'s canonical username, not an e-mail from the path (R-13)', async () => {
      userGroups(`t-${IDS.a}`);
      cognito.on(AdminGetUserCommand).resolves({ Username: 'sub-u1', UserAttributes: [{ Name: 'email', Value: 'u1@example.com' }], UserStatus: 'CONFIRMED' });
      const view = await provisioner().getUser(tenantA(), 'u1@example.com');
      expect(view.username).toBe('sub-u1');
    });
  });

  describe('createUser reuse reports actual admin membership', () => {
    it('admin=false on a user already in admin-<tenant> returns admin=true', async () => {
      cognito.on(ListUsersCommand).resolves({ Users: [{ Username: 'existing', Attributes: [{ Name: 'email', Value: 'u1@example.com' }, { Name: 'email_verified', Value: 'true' }] }] });
      cognito.on(AdminAddUserToGroupCommand).resolves({});
      userGroups(`t-${IDS.a}`, `admin-${IDS.a}`, `t-${IDS.b}`);
      const result = await provisioner().createUser(tenantA(), 'u1@example.com', false);
      expect(result.user.admin).toBe(true);
    });

    it('admin=false on a user who is admin elsewhere only returns admin=false', async () => {
      cognito.on(ListUsersCommand).resolves({ Users: [{ Username: 'existing', Attributes: [{ Name: 'email', Value: 'u1@example.com' }, { Name: 'email_verified', Value: 'true' }] }] });
      cognito.on(AdminAddUserToGroupCommand).resolves({});
      userGroups(`t-${IDS.a}`, `t-${IDS.b}`, `admin-${IDS.b}`);
      const result = await provisioner().createUser(tenantA(), 'u1@example.com', false);
      expect(result.user.admin).toBe(false);
    });
  });

  describe('deleteMembership race (P-4)', () => {
    it('deletes the Cognito user when a concurrent removal left no t- group', async () => {
      // assertMember and the last-tenant check both see A and B; by the time
      // A is removed, a concurrent call has already removed B.
      cognito
        .on(AdminListGroupsForUserCommand)
        .resolvesOnce({ Groups: [{ GroupName: `t-${IDS.a}` }, { GroupName: `t-${IDS.b}` }] }) // assertMember
        .resolvesOnce({ Groups: [{ GroupName: `t-${IDS.a}` }, { GroupName: `t-${IDS.b}` }] }) // last-tenant check
        .resolves({ Groups: [] }); // after removal
      cognito.on(AdminRemoveUserFromGroupCommand).resolves({});
      cognito.on(AdminDeleteUserCommand).resolves({});
      await provisioner().deleteMembership(tenantA(), 'u1');
      expect(cognito).toHaveReceivedCommandTimes(AdminDeleteUserCommand as AnyMock, 1);
    });

    it('keeps the user when another t- group still remains after removal', async () => {
      cognito
        .on(AdminListGroupsForUserCommand)
        .resolvesOnce({ Groups: [{ GroupName: `t-${IDS.a}` }, { GroupName: `t-${IDS.b}` }] })
        .resolvesOnce({ Groups: [{ GroupName: `t-${IDS.a}` }, { GroupName: `t-${IDS.b}` }] })
        .resolves({ Groups: [{ GroupName: `t-${IDS.b}` }] });
      cognito.on(AdminRemoveUserFromGroupCommand).resolves({});
      await provisioner().deleteMembership(tenantA(), 'u1');
      expect(cognito).toHaveReceivedCommandTimes(AdminDeleteUserCommand as AnyMock, 0);
    });
  });

  describe('assertEmailAvailable', () => {
    it('is a no-op: an existing e-mail is reused (spec §7.3)', async () => {
      await expect(provisioner().assertEmailAvailable('u1@example.com')).resolves.toBeUndefined();
      expect(cognito.calls()).toHaveLength(0);
    });
  });

  describe('setAdmin happy path', () => {
    it('promote adds to admin-<tenant> and returns admin=true', async () => {
      cognito.on(AdminAddUserToGroupCommand).resolves({});
      cognito
        .on(AdminListGroupsForUserCommand)
        .resolvesOnce({ Groups: [{ GroupName: `t-${IDS.a}` }] }) // assertMember
        .resolves({ Groups: [{ GroupName: `t-${IDS.a}` }, { GroupName: `admin-${IDS.a}` }] });
      cognito.on(AdminGetUserCommand).resolves({ Username: 'u1', UserAttributes: [], UserStatus: 'CONFIRMED' });
      const view = await provisioner().setAdmin(tenantA(), 'u1', true);
      expect(cognito.commandCalls(AdminAddUserToGroupCommand)[0].args[0].input).toMatchObject({ UserPoolId: POOL, Username: 'u1', GroupName: `admin-${IDS.a}` });
      expect(view.admin).toBe(true);
    });

    it('demote removes from admin-<tenant> and returns admin=false', async () => {
      cognito.on(AdminRemoveUserFromGroupCommand).resolves({});
      cognito
        .on(AdminListGroupsForUserCommand)
        .resolvesOnce({ Groups: [{ GroupName: `t-${IDS.a}` }, { GroupName: `admin-${IDS.a}` }] })
        .resolves({ Groups: [{ GroupName: `t-${IDS.a}` }] });
      cognito.on(AdminGetUserCommand).resolves({ Username: 'u1', UserAttributes: [], UserStatus: 'CONFIRMED' });
      const view = await provisioner().setAdmin(tenantA(), 'u1', false);
      expect(cognito.commandCalls(AdminRemoveUserFromGroupCommand)[0].args[0].input).toMatchObject({ GroupName: `admin-${IDS.a}` });
      expect(view.admin).toBe(false);
    });
  });

  describe('setScopes / grantedScopes (ADR-0036, JSON object keyed by tenant)', () => {
    const otherTenant = '01C0ABCDEFGHJKMNPQRSTVWXYZ';

    it('replaces this tenant\'s key and keeps the other tenants\' grants', async () => {
      cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: [{ GroupName: `t-${IDS.a}` }, { GroupName: `t-${otherTenant}` }] });
      const before = JSON.stringify({ [otherTenant]: 'billing/read', [IDS.a]: 'sample/read sample/write' });
      const after = JSON.stringify({ [otherTenant]: 'billing/read', [IDS.a]: 'sample/read' });
      cognito
        .on(AdminGetUserCommand)
        .resolvesOnce({ Username: 'u1', UserAttributes: [{ Name: 'custom:scopes', Value: before }], UserStatus: 'CONFIRMED' })
        .resolves({ Username: 'u1', UserAttributes: [{ Name: 'custom:scopes', Value: after }], UserStatus: 'CONFIRMED' });
      cognito.on(AdminUpdateUserAttributesCommand).resolves({});
      const view = await provisioner().setScopes(tenantA(), 'u1', ['sample/read']);
      const written = cognito.commandCalls(AdminUpdateUserAttributesCommand)[0].args[0].input.UserAttributes[0];
      expect(written.Name).toBe('custom:scopes');
      expect(JSON.parse(written.Value)).toEqual({ [otherTenant]: 'billing/read', [IDS.a]: 'sample/read' });
      expect(view.grantedScopes).toEqual(['sample/read']);
    });

    it('starts a new object when the attribute is absent', async () => {
      cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: [{ GroupName: `t-${IDS.a}` }] });
      cognito.on(AdminGetUserCommand).resolves({ Username: 'u1', UserAttributes: [], UserStatus: 'CONFIRMED' });
      cognito.on(AdminUpdateUserAttributesCommand).resolves({});
      await provisioner().setScopes(tenantA(), 'u1', []);
      const written = cognito.commandCalls(AdminUpdateUserAttributesCommand)[0].args[0].input.UserAttributes[0];
      expect(JSON.parse(written.Value)).toEqual({ [IDS.a]: '-' });
    });

    it('getUser reads only this tenant\'s key; another tenant\'s grant is never shown (spec §5.1)', async () => {
      cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: [{ GroupName: `t-${IDS.a}` }, { GroupName: `t-${otherTenant}` }] });
      cognito.on(AdminGetUserCommand).resolves({
        Username: 'u1',
        UserAttributes: [{ Name: 'custom:scopes', Value: JSON.stringify({ [otherTenant]: 'billing/read' }) }],
        UserStatus: 'CONFIRMED',
      });
      const view = await provisioner().getUser(tenantA(), 'u1');
      expect(view.grantedScopes).toBeUndefined();
      expect(JSON.stringify(view)).not.toContain(otherTenant);
    });

    it('a non-member is a 404 and nothing is written (R-12)', async () => {
      cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: [{ GroupName: `t-${otherTenant}` }] });
      await expect(provisioner().setScopes(tenantA(), 'u1', ['sample/read'])).rejects.toBeInstanceOf(NotFoundError);
      expect(cognito.commandCalls(AdminUpdateUserAttributesCommand)).toHaveLength(0);
    });
  });
});
