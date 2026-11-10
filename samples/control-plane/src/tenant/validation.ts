// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Stack, Token } from 'aws-cdk-lib';
import { RegionInfo } from 'aws-cdk-lib/region-info';

/**
 * Synth-time validation of the deployment inputs (spec §3.3) and the shapes
 * they take. Shared by the control plane stack and the account role pair
 * stack, so it lives apart from either.
 */

/** Where provisioning code lives - a CodeBuild ProjectSource reference. */
export interface SourceDefinition {
  /** CodeBuild source type, e.g. GITHUB, S3, CODECOMMIT. */
  readonly type: string;
  /** Source location, e.g. a git clone URL. */
  readonly location: string;
  /**
   * Optional git ref forwarded to CodeBuild StartBuild as `SourceVersion`.
   * A full 40-character commit SHA pins the provisioning source immutably
   * (threat model T5, mitigation M10) — anything else is a mutable ref and
   * triggers a synth-time warning in `main.ts`.
   */
  readonly sourceVersion?: string;
}

/** The three lifecycle script paths within the source. */
export interface ScriptLocations {
  readonly create: string;
  readonly update: string;
  readonly delete: string;
}

/**
 * The deployment-configured CellDefinition (ADR-012): one source plus two
 * script sets. Changing it affects only cells created afterwards - existing
 * cells keep their stamped definition.
 */
export interface CellDefinition {
  /** Provisioning source, stamped onto new cell records. */
  readonly source: SourceDefinition;
  /** Shared cell deployment lifecycle scripts. */
  readonly cellScripts: ScriptLocations;
  /** Per-tenant deployment lifecycle scripts. */
  readonly tenantScripts: ScriptLocations;
  /** Cell capacity, stamped at cell creation. Integer >= 1. */
  readonly maxTenants: number;
}

/**
 * Synth-time validation of the cellDefinition deployment input (§10):
 * `maxTenants` must be an integer of at least one; source and every script
 * value must be non-empty. Throws with a clear message otherwise.
 */
export function validateCellDefinition(definition: CellDefinition): void {
  const problems: string[] = [];
  const requireNonEmpty = (name: string, value: unknown) => {
    if (typeof value !== 'string' || value.trim() === '') {
      problems.push(`${name} must be a non-empty string`);
    }
  };

  requireNonEmpty('cellDefinition.source.type', definition?.source?.type);
  requireNonEmpty('cellDefinition.source.location', definition?.source?.location);
  for (const scriptSet of ['cellScripts', 'tenantScripts'] as const) {
    for (const operation of ['create', 'update', 'delete'] as const) {
      requireNonEmpty(`cellDefinition.${scriptSet}.${operation}`, definition?.[scriptSet]?.[operation]);
    }
  }
  if (!Number.isInteger(definition?.maxTenants) || definition.maxTenants < 1) {
    problems.push(`cellDefinition.maxTenants must be an integer >= 1 (got: ${JSON.stringify(definition?.maxTenants)})`);
  }

  if (problems.length > 0) {
    throw new Error(
      'Invalid cellDefinition deployment input (architecture.md §10):\n'
      + problems.map((p) => `  - ${p}`).join('\n')
      + '\nSupply it via CDK context, e.g. cdk.json or --context cellDefinition=\'{"source":{"type":"GITHUB","location":"https://..."},"cellScripts":{"create":"...","update":"...","delete":"..."},"tenantScripts":{"create":"...","update":"...","delete":"..."},"maxTenants":10}\'',
    );
  }
}

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
