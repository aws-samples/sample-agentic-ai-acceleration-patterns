// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The probe stacks `probes.sh` runs against (README, "Probe the policies"). They exist for
 * the length of a probe run only.
 *
 * - `CellBoundaryProbeStack`, an owner stack (legacy synthesizer, owner credentials):
 *   `cell/cell-policy-probe`, under the cell permissions boundary, standing in for the
 *   execution role, with a trust that refuses every `/cell/` principal. The execution
 *   role cannot create it: a role it creates must carry
 *   the workload boundary (ADR-0011). The stack also holds the decoys every escalation
 *   outside `/cell/` aims at, so a probe that a regressed policy lets through changes
 *   nothing the account uses: `cell-policy-probe-decoy`, a role on `/` with no policy that
 *   only the probe roles may assume, `cell-policy-probe-decoy`, a managed policy
 *   attached to nothing, and an empty table and a KMS key of the same name for the
 *   resource-policy probes.
 * - `CellWorkloadProbeStack`, deployed through the cell bootstrap: `cell/cell-policy-probe-workload`
 *   under the workload boundary, which the execution role sets from the cell synth
 *   context, plus two targets: `cell-policy-probe-target` (a role the probes change or
 *   pass) and `cell-policy-probe-tenant` (a role the workload probe assumes, as the TVM does).
 *
 * Both probe roles hold an identity policy that allows every escalation the probes try,
 * so only a boundary can refuse one.
 */

import { Duration, LegacyStackSynthesizer, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import type { Construct } from 'constructs';
import { applyCellRolePath } from './cell-path';
import type { CellPolicyNames } from './cell-policies';
import { acknowledgeGranularFinding } from '../driver/nag';

export const PROBE_ROLES = {
  boundary: 'cell-policy-probe',
  decoy: 'cell-policy-probe-decoy',
  workload: 'cell-policy-probe-workload',
  target: 'cell-policy-probe-target',
  tenant: 'cell-policy-probe-tenant',
} as const;

/** The decoy managed policy the policy-version probes aim at. */
export const PROBE_DECOY_POLICY = 'cell-policy-probe-decoy';
/** The decoy table and key alias the resource-policy probes aim at (the services check the resource before IAM). */
export const PROBE_DECOY_TABLE = 'cell-policy-probe-decoy';
export const PROBE_DECOY_KEY_ALIAS = 'alias/cell-policy-probe-decoy';

/** The stack tag of the probe stacks, so the account check and a leftover check can find them. */
export const PROBE_TAG = { key: 'stress:part', value: 'cell-policy-probe' } as const;

/** Every escalation the probes try, allowed on `*` so that only a boundary refuses. */
export const PROBE_ACTIONS = [
  'iam:*',
  'sts:AssumeRole',
  'lambda:CreateFunction',
  'lambda:DeleteFunction',
  'lambda:CreateFunctionUrlConfig',
  'lambda:AddPermission',
  'logs:PutDestination',
  'logs:DeleteDestination',
  'logs:PutResourcePolicy',
  'logs:DeleteResourcePolicy',
  'dynamodb:PutResourcePolicy',
  'kms:PutKeyPolicy',
  'ssm:PutParameter',
  'ssm:DeleteParameter',
  'apigateway:PATCH',
] as const;

function probeRole(
  scope: Construct,
  id: string,
  roleName: string,
  description: string,
  trust: iam.IPrincipal = new iam.AccountRootPrincipal(),
): iam.Role {
  const role = new iam.Role(scope, id, { roleName, assumedBy: trust, description });
  role.addToPolicy(new iam.PolicyStatement({ sid: 'EveryEscalation', actions: [...PROBE_ACTIONS], resources: ['*'] }));
  const reason = 'A probe role: its identity policy allows every escalation on purpose, so the probes show that the boundary alone refuses each one.';
  for (const finding of ['AwsSolutions-IAM5[Resource::*]', ...PROBE_ACTIONS.filter((a) => a.includes('*')).map((a) => `AwsSolutions-IAM5[Action::${a}]`)]) {
    acknowledgeGranularFinding(role, finding, reason);
  }
  return role;
}

export interface CellBoundaryProbeStackProps extends Omit<StackProps, 'synthesizer'> {
  readonly names: CellPolicyNames;
}

/** The execution role's stand-in: a `/cell/` role under the cell permissions boundary. */
export class CellBoundaryProbeStack extends Stack {
  constructor(scope: Construct, id: string, props: CellBoundaryProbeStackProps) {
    super(scope, id, { ...props, synthesizer: new LegacyStackSynthesizer(), tags: { ...props.tags, [PROBE_TAG.key]: PROBE_TAG.value } });
    // The stand-in holds the cell permissions boundary's IAM headroom, and the workload
    // boundary allows sts:AssumeRole on role/cell/*: its trust refuses every /cell/
    // principal, so only the account owner can assume it (ADR-0011).
    const ownerOnly = new iam.AccountRootPrincipal().withConditions({
      ArnNotLike: { 'aws:PrincipalArn': `arn:${this.partition}:iam::${this.account}:role/cell/*` },
    });
    const role = probeRole(this, 'BoundaryProbeRole', PROBE_ROLES.boundary, 'Stands in for the cell execution role; only the cell permissions boundary may refuse', ownerOnly);
    iam.PermissionsBoundary.of(role).apply(iam.ManagedPolicy.fromManagedPolicyName(this, 'Boundary', props.names.boundary));
    // Only the probe role goes on /cell/; the decoy stays on /.
    applyCellRolePath(role);

    // Trusted by the account, but only for the probe roles, so a policy that a regression
    // lets a probe attach to it gives nobody else a way in.
    new iam.Role(this, 'DecoyRole', {
      roleName: PROBE_ROLES.decoy,
      assumedBy: new iam.AccountRootPrincipal().withConditions({
        ArnLike: { 'aws:PrincipalArn': `arn:${this.partition}:iam::${this.account}:role/cell/${PROBE_ROLES.boundary}*` },
      }),
      description: 'Decoy on / for the cell policy probes; holds no policy',
    });
    new iam.ManagedPolicy(this, 'DecoyPolicy', {
      managedPolicyName: PROBE_DECOY_POLICY,
      description: 'Decoy for the cell policy probes; attached to nothing',
      statements: [new iam.PolicyStatement({ sid: 'Nothing', effect: iam.Effect.DENY, actions: ['*'], resources: ['*'] })],
    });
    // Empty, on demand, gone with the stack.
    new dynamodb.TableV2(this, 'DecoyTable', {
      tableName: PROBE_DECOY_TABLE,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    new kms.Key(this, 'DecoyKey', {
      alias: PROBE_DECOY_KEY_ALIAS,
      description: 'Decoy for the cell policy probes; encrypts nothing',
      enableKeyRotation: true,
      pendingWindow: Duration.days(7),
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }
}

/**
 * A cell's roles, through the cell bootstrap. The app sets the cell synth context, so
 * every role here gets the workload boundary from the CDK and `/cell/` from the aspect.
 */
export class CellWorkloadProbeStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, { ...props, tags: { ...props.tags, [PROBE_TAG.key]: PROBE_TAG.value } });
    probeRole(this, 'WorkloadProbeRole', PROBE_ROLES.workload, 'A compromised cell role; only the cell workload boundary may refuse');
    new iam.Role(this, 'TargetRole', {
      roleName: PROBE_ROLES.target,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'A cell role the probes change or pass (positive and negative controls)',
    });
    new iam.Role(this, 'TenantRole', {
      roleName: PROBE_ROLES.tenant,
      assumedBy: new iam.AccountRootPrincipal(),
      description: 'A cell tenant role the workload probe assumes, as the TVM does',
    });
    applyCellRolePath(this);
  }
}
