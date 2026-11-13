// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { isPermitted, READER_OPERATIONS, withGrantCheck } from '../../src/shared/grant-check';
import type { CallerContext } from '../../src/shared/service-config';
import { UnauthorizedError } from '../../src/smithy/source/typescript-ssdk-codegen/src';

/**
 * The service's own grant check (spec R-36, M26): the wall behind the
 * authorizer's GET-only policy. The integration test can only reach the
 * policy (API Gateway refuses a reader's write first), so this file is the
 * evidence for the second wall.
 */

const operator: CallerContext = { operatorId: 'op-1', role: 'operator', grant: 'operator' };
const reader: CallerContext = { operatorId: 'reader-1', role: 'control-plane:reader', grant: 'reader' };

// Every operation of the model (spec §5): ten reads, twelve others.
const ALL_OPERATIONS = [
  'CreateTenant', 'GetTenant', 'UpdateTenant', 'DeleteTenant', 'ListTenants',
  'CreateDeployment', 'GetDeployment', 'UpdateDeployment', 'DeleteDeployment', 'ListDeployments',
  'ListCells', 'GetCell', 'UpdateCell', 'DeleteCell',
  'PutAccount', 'GetAccount', 'ListAccounts', 'DeleteAccount',
  'PutApplication', 'GetApplication', 'ListApplications', 'DeleteApplication',
];
const WRITE_OPERATIONS = ALL_OPERATIONS.filter((op) => !READER_OPERATIONS.has(op));

/** A stand-in service: every operation records that it ran. */
function fakeService(): { ran: string[]; service: Record<string, (i: unknown, c: CallerContext) => Promise<string>> } {
  const ran: string[] = [];
  const service = Object.fromEntries(
    ALL_OPERATIONS.map((op) => [op, async () => {
      ran.push(op);
      return op;
    }]),
  );
  return { ran, service };
}

test('the model has twenty-two operations, ten of them reads (spec §5, R-36)', () => {
  expect(ALL_OPERATIONS).toHaveLength(22);
  expect(READER_OPERATIONS.size).toBe(10);
  expect(WRITE_OPERATIONS).toHaveLength(12);
  for (const op of READER_OPERATIONS) {
    expect(ALL_OPERATIONS).toContain(op);
  }
});

test('an operator may run every operation', () => {
  for (const op of ALL_OPERATIONS) {
    expect(isPermitted(op, operator)).toBe(true);
  }
});

test.each([...READER_OPERATIONS])('a reader may run %s', async (op) => {
  const { ran, service } = fakeService();
  await expect(withGrantCheck(service)[op]({}, reader)).resolves.toBe(op);
  expect(ran).toEqual([op]);
});

test.each(WRITE_OPERATIONS)('a reader is refused %s with UnauthorizedError, nothing run', async (op) => {
  const { ran, service } = fakeService();
  await expect(withGrantCheck(service)[op]({}, reader)).rejects.toBeInstanceOf(UnauthorizedError);
  expect(ran).toEqual([]);
});

test('an operation not in the read list is an operator operation', () => {
  expect(isPermitted('SomeNewOperation', reader)).toBe(false);
  expect(isPermitted('SomeNewOperation', operator)).toBe(true);
});

test('an unknown grant value is refused every write', () => {
  const odd = { operatorId: 'x', grant: 'auditor' } as unknown as CallerContext;
  for (const op of WRITE_OPERATIONS) {
    expect(isPermitted(op, odd)).toBe(false);
  }
});
