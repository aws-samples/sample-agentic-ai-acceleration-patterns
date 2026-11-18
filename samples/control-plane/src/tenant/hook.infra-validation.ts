// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { StackIdentity, validateTenantBuildManagedPolicyArns } from './validation';

/**
 * Synth-time validation of the two hook-role policy inputs (spec §3.3, R-41,
 * ADR-044, M30). `globalHookManagedPolicyArns` and `appHookManagedPolicyArns`
 * are validated exactly as `tenantBuildManagedPolicyArns` is (ADR-022): every
 * entry a literal customer-managed policy ARN in the stack's own partition and
 * account, and a non-empty list on an environment-agnostic stack fails synth.
 * On top of that an ARN in both lists fails synth, so no policy reaches both
 * scopes by accident (T41): an application hook must never hold what a global
 * hook holds.
 */

/** The validated hook policy lists; each is empty when its input is omitted. */
export interface HookManagedPolicyArns {
  readonly global: readonly string[];
  readonly app: readonly string[];
}

/**
 * Validates both hook policy inputs. Delegates the per-ARN rules to
 * {@link validateTenantBuildManagedPolicyArns} so the two inputs cannot drift
 * from the original, and renames the error so it names the input the
 * deployer actually set.
 */
export function validateHookManagedPolicyArns(
  globalArns: unknown,
  appArns: unknown,
  identity: StackIdentity,
): HookManagedPolicyArns {
  validateOne('globalHookManagedPolicyArns', globalArns, identity);
  validateOne('appHookManagedPolicyArns', appArns, identity);
  // Both are arrays of strings from here (the checks above throw otherwise).
  const global = (globalArns ?? []) as string[];
  const app = (appArns ?? []) as string[];
  const shared = global.filter((arn) => app.includes(arn));
  if (shared.length > 0) {
    throw new Error(
      'Invalid hook managed policy inputs (spec R-41, T41):\n'
      + shared.map((arn) => `  - ${arn} is in both globalHookManagedPolicyArns and appHookManagedPolicyArns; a policy must reach one hook scope only`).join('\n')
      + '\nAn application hook must not hold what a global hook holds. Attach a separate policy to each hook role.',
    );
  }
  return { global, app };
}

function validateOne(name: string, arns: unknown, identity: StackIdentity): void {
  try {
    validateTenantBuildManagedPolicyArns(arns, identity);
  } catch (error) {
    throw new Error(
      (error as Error).message
        .replace(/tenantBuildManagedPolicyArns/g, name)
        .replace('(ADR-022)', '(spec R-41, ADR-044)'),
    );
  }
}
