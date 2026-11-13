// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Stack, Token } from 'aws-cdk-lib';
import { RegionInfo } from 'aws-cdk-lib/region-info';

/**
 * Synth-time validation of the stack inputs (spec §3.3). Shared by the
 * control plane stack and the account role pair stack, so it lives apart
 * from either. Applications and accounts are not stack inputs — they are
 * registered through the API and validated by the generated SSDK.
 */

/**
 * A customer-managed IAM policy ARN: `arn:<partition>:iam::<account>:policy/<path><name>`.
 * The account segment is twelve digits, which also rejects AWS managed
 * policies (`iam::aws:policy/...`) - the input is for policies the deployer
 * owns in this account (ADR-022). The path is zero or more non-empty
 * segments, each followed by `/`, then a non-empty name, so `policy//`,
 * `policy/foo/` and `policy/a//b` are rejected at synth rather than by IAM
 * at deploy.
 */
const MANAGED_POLICY_ARN = /^arn:([a-z][a-z0-9-]*):iam::(\d{12}):policy\/(?:[\w+=,.@-]+\/)*[\w+=,.@-]+$/;

/** The partition and account a managed-policy ARN must belong to. */
export interface StackIdentity {
  readonly partition: string;
  readonly account: string;
}

/**
 * The stack's partition and account for ARN validation. `Stack.partition`
 * is the `AWS::Partition` pseudo-parameter unless the
 * `@aws-cdk/core:enablePartitionLiterals` flag is on, so the partition is
 * derived here from the Region when that is resolved (the same RegionInfo
 * lookup CDK itself uses); the account is `Stack.account` as given.
 */
export function stackIdentity(stack: Stack): StackIdentity {
  const partition = Token.isUnresolved(stack.region)
    ? stack.partition
    : RegionInfo.get(stack.region).partition ?? stack.partition;
  return { partition, account: stack.account };
}

/**
 * Synth-time validation of the `tenantBuildManagedPolicyArns` deployment
 * input (ADR-022): every entry must be a literal customer-managed IAM policy
 * ARN in the stack's own partition and account. Throws with every problem
 * listed otherwise.
 *
 * The partition (derived from the Region, see `stackIdentity`) and the
 * account must be resolved at synth time for that comparison, so a non-empty
 * list on an environment-agnostic stack (either one still a CDK token) fails
 * synth rather than deferring the cross-account check to IAM at deploy.
 * `src/main.ts` passes `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION`, so a
 * real `cdk deploy` resolves both; an omitted or empty list never needs them.
 */
export function validateTenantBuildManagedPolicyArns(
  arns: unknown,
  stack: StackIdentity,
): void {
  if (arns === undefined) {
    return;
  }
  const problems: string[] = [];
  if (!Array.isArray(arns)) {
    problems.push(`must be an array of strings (got: ${JSON.stringify(arns)})`);
  } else if (arns.length > 0 && (Token.isUnresolved(stack.partition) || Token.isUnresolved(stack.account))) {
    const unresolved = [
      ...(Token.isUnresolved(stack.partition) ? ['region (partition)'] : []),
      ...(Token.isUnresolved(stack.account) ? ['account'] : []),
    ].join(' and ');
    problems.push(
      `the stack's ${unresolved} must be resolved at synth time to check that each ARN belongs to this stack; `
      + 'this stack is environment-agnostic. Deploy with `cdk deploy` (src/main.ts passes CDK_DEFAULT_ACCOUNT / '
      + 'CDK_DEFAULT_REGION) or set `env: { account, region }` on the stack',
    );
  } else {
    arns.forEach((arn, index) => {
      const match = typeof arn === 'string' ? MANAGED_POLICY_ARN.exec(arn) : null;
      if (match === null) {
        problems.push(`[${index}] ${JSON.stringify(arn)} is not a customer-managed IAM policy ARN (arn:<partition>:iam::<account>:policy/<name>)`);
        return;
      }
      const [, partition, account] = match;
      if (partition !== stack.partition) {
        problems.push(`[${index}] ${arn} is in partition '${partition}'; this stack deploys to '${stack.partition}'`);
      }
      if (account !== stack.account) {
        problems.push(`[${index}] ${arn} is in account ${account}; this stack deploys to ${stack.account}`);
      }
    });
  }
  if (problems.length > 0) {
    throw new Error(
      'Invalid tenantBuildManagedPolicyArns deployment input (ADR-022):\n'
      + problems.map((p) => `  - ${p}`).join('\n')
      + '\nEach entry must be a managed-policy ARN in this stack\'s partition and account, e.g. --context tenantBuildManagedPolicyArns=\'["arn:aws:iam::123456789012:policy/MyPolicy"]\'',
    );
  }
}

/** The validated role lists the authorizer maps to grants (spec R-36). */
export interface RoleLists {
  readonly allowedRoles: readonly string[];
  readonly readerRoles: readonly string[];
}

/** A role value either list may hold (spec §3.3); mirrors `ROLE_VALUE_PATTERN`. */
const ROLE_VALUE = /^[A-Za-z0-9:._-]{1,64}$/;

/**
 * Validates `allowedRoles` and `readerRoles` at synth (spec §3.3, R-36): the
 * operator list is non-empty (default `['operator']`), the reader list
 * defaults to empty, every value matches the role pattern, and no value is
 * in both lists. Fails synth with every problem named.
 */
export function validateRoleLists(
  allowedRoles: string[] | undefined,
  readerRoles: string[] | undefined,
): RoleLists {
  const allowed = allowedRoles ?? ['operator'];
  const readers = readerRoles ?? [];
  const problems: string[] = [];
  for (const [name, list] of [['allowedRoles', allowed], ['readerRoles', readers]] as const) {
    if (!Array.isArray(list)) {
      problems.push(`${name} must be an array of strings (got: ${JSON.stringify(list)})`);
      continue;
    }
    list.forEach((role, index) => {
      if (typeof role !== 'string' || !ROLE_VALUE.test(role)) {
        problems.push(`${name}[${index}] ${JSON.stringify(role)} does not match ${ROLE_VALUE.source}`);
      }
    });
  }
  if (Array.isArray(allowed) && allowed.length === 0) {
    problems.push('allowedRoles must name at least one role (omit it for the default, operator)');
  }
  if (Array.isArray(allowed) && Array.isArray(readers)) {
    for (const role of readers.filter((value) => allowed.includes(value))) {
      problems.push(`${JSON.stringify(role)} is in both allowedRoles and readerRoles; a role value maps to one grant`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Invalid role lists (spec R-36):\n  - ${problems.join('\n  - ')}`);
  }
  return { allowedRoles: allowed, readerRoles: readers };
}
