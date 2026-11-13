// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { CallerContext } from './service-config';
import { UnauthorizedError } from '../smithy/source/typescript-ssdk-codegen/src';

/**
 * The service's own check of the caller's grant (spec R-36, M26): the
 * second wall behind the authorizer's method-scoped policy.
 *
 * It is defined independently of the policy: by operation name, not by HTTP
 * method, so one mistake in a method-based helper cannot open both walls.
 * The ten read operations are open to every grant; every other operation
 * requires `operator`. An operation that is not in this list is refused to a
 * reader, so a new operation is an operator operation until it is listed.
 */
export const READER_OPERATIONS: ReadonlySet<string> = new Set([
  'GetTenant',
  'ListTenants',
  'GetDeployment',
  'ListDeployments',
  'GetCell',
  'ListCells',
  'GetAccount',
  'ListAccounts',
  'GetApplication',
  'ListApplications',
]);

/** Whether a caller with this context may run the named operation. */
export function isPermitted(operation: string, context: CallerContext): boolean {
  return context.grant === 'operator' || READER_OPERATIONS.has(operation);
}

/**
 * Wraps a Smithy service implementation so every operation checks the
 * caller's grant before it runs. A refused call throws the modelled
 * `UnauthorizedError` (403); nothing in the service runs.
 */
export function withGrantCheck<T extends object>(service: T): T {
  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || typeof value !== 'function' || !/^[A-Z]/.test(property)) {
        return value;
      }
      return async (input: unknown, context: CallerContext) => {
        if (!isPermitted(property, context)) {
          throw new UnauthorizedError({
            message: `The ${context.grant} grant does not include ${property}`,
          });
        }
        return (value as (i: unknown, c: CallerContext) => Promise<unknown>).call(target, input, context);
      };
    },
  });
}
