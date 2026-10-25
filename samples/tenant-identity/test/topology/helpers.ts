// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Shared test helpers for the topology provisioner suites. The Cognito mock
 * is typed loosely: the pinned top-level @smithy/types (4.17.2) diverges from
 * the 4.19.0 the SDK clients resolve, so aws-sdk-client-mock's command
 * generics do not unify. `any` at the mock boundary keeps the suites readable;
 * the provisioners under test are fully typed.
 */

import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';
import type { TenantRecord } from '../../src/shared/registry';
import type { ProvisionerDeps } from '../../src/topology/index';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyMock = any;

/** A loosely-typed Cognito mock (see file header). */
export function cognitoMock(): AnyMock {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mockClient(CognitoIdentityProviderClient as any);
}

/** A ProvisionerDeps whose Cognito client is the mock. */
export function depsFor(
  mock: AnyMock,
  over: Partial<ProvisionerDeps> = {},
): ProvisionerDeps {
  return {
    cognito: mock as unknown as CognitoIdentityProviderClient,
    region: 'eu-central-1',
    ...over,
  };
}

const TENANT_A = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
const TENANT_B = '01ARZ3NDEKTSV4RRFFQ69G5FBB';

export const IDS = { a: TENANT_A, b: TENANT_B };

export function tenant(over: Partial<TenantRecord> = {}): TenantRecord {
  return {
    tenantId: TENANT_A,
    name: 'Tenant A',
    status: 'ACTIVE',
    topology: 'shared-pool',
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    ...over,
  };
}

/** A Cognito error with the given exception name. */
export function cognitoError(name: string, message = 'cognito'): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}
