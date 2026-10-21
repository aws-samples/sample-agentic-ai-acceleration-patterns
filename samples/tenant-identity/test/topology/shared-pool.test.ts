// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminInitiateAuthCommand,
  AdminListGroupsForUserCommand,
  AdminSetUserPasswordCommand,
  CreateGroupCommand,
  DeleteGroupCommand,
  ListUsersCommand,
  ListUsersInGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import 'aws-sdk-client-mock-jest';
import { AnyMock, cognitoError, cognitoMock, depsFor, IDS, tenant } from './helpers';
import { ConflictError, NotFoundError, UnsupportedInTopologyError } from '../../src/shared/errors';
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
      cognito.on(AdminCreateUserCommand).resolves({ User: { Username: 'u1', Attributes: [{ Name: 'email', Value: 'u1@x.com' }, { Name: TENANT_ATTR, Value: IDS.a }] } });
      cognito.on(AdminAddUserToGroupCommand).resolves({});
      const result = await provisioner().createUser(tenantA(), 'u1@x.com', true);
      expect(result.temporaryPassword).toBeDefined();
      const attrs = cognito.commandCalls(AdminCreateUserCommand)[0].args[0].input.UserAttributes;
      expect(attrs).toEqual(expect.arrayContaining([{ Name: TENANT_ATTR, Value: IDS.a }]));
      const groups = cognito.commandCalls(AdminAddUserToGroupCommand).map((c: AnyMock) => c.args[0].input.GroupName);
      expect(groups).toEqual([`t-${IDS.a}`, `admin-${IDS.a}`]);
    });

    it('rejects an e-mail already in the pool with ConflictError (§5.3, §7.2)', async () => {
      cognito.on(ListUsersCommand).resolves({ Users: [{ Username: 'existing' }] });
      await expect(provisioner().createUser(tenantA(), 'u1@x.com', false)).rejects.toBeInstanceOf(ConflictError);
      expect(cognito).toHaveReceivedCommandTimes(AdminCreateUserCommand as AnyMock, 0);
    });

    it('never logs the temporary password', async () => {
      cognito.on(ListUsersCommand).resolves({ Users: [] });
      cognito.on(AdminCreateUserCommand).resolves({ User: { Username: 'u1' } });
      cognito.on(AdminAddUserToGroupCommand).resolves({});
      const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const result = await provisioner().createUser(tenantA(), 'u1@x.com', false);
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
      cognito.on(AdminGetUserCommand).resolves({ Username: 'u1', UserAttributes: [{ Name: TENANT_ATTR, Value: IDS.a }, { Name: 'email', Value: 'u1@x.com' }], UserStatus: 'CONFIRMED', UserCreateDate: new Date() });
      cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: [{ GroupName: `admin-${IDS.a}` }] });
      const view = await provisioner().getUser(tenantA(), 'u1');
      expect(view.admin).toBe(true);
    });

    it('getUser returns Cognito\'s canonical username, not an e-mail from the path (R-13)', async () => {
      cognito.on(AdminGetUserCommand).resolves({ Username: 'sub-u1', UserAttributes: [{ Name: TENANT_ATTR, Value: IDS.a }], UserStatus: 'CONFIRMED' });
      cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: [] });
      const view = await provisioner().getUser(tenantA(), 'u1@x.com');
      expect(view.username).toBe('sub-u1');
    });

    it('getUser fails closed when Cognito returns no Username (R-13)', async () => {
      cognito.on(AdminGetUserCommand).resolves({ UserAttributes: [{ Name: TENANT_ATTR, Value: IDS.a }], UserStatus: 'CONFIRMED' });
      cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: [] });
      await expect(provisioner().getUser(tenantA(), 'u1@x.com')).rejects.toThrow('AdminGetUser returned no Username');
    });

    it('listUsers lists t- group members with admin flag', async () => {
      cognito.on(ListUsersInGroupCommand).callsFake((input: AnyMock) => {
        if (input.GroupName === `admin-${IDS.a}`) {
          return { Users: [{ Username: 'u1' }] };
        }
        return { Users: [{ Username: 'u1', Attributes: [{ Name: 'email', Value: 'u1@x.com' }] }, { Username: 'u2' }] };
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
});
