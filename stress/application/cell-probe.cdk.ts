// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The probe stacks `probes.sh` runs against (README, "Probe the policies"). They exist for
 * the length of a probe run only.
 *
 * - `CellBoundaryProbeStack`, an owner stack (legacy synthesizer, owner credentials):
 *   `cell/cell-policy-probe`, under the cell permissions boundary, standing in for the
 *   execution role. The execution role cannot create it: a role it creates must carry
 *   the workload boundary (ADR-0011).
 * - `CellWorkloadProbeStack`, deployed through the cell bootstrap: `cell/cell-policy-probe-workload`
 *   under the workload boundary, which the execution role sets from the cell synth
 *   context, plus two targets: `cell-policy-probe-target` (a role the probes change or
 *   pass) and `cell-policy-probe-tenant` (a role the workload probe assumes, as the TVM does).
 *
 * Both probe roles hold an identity policy that allows every escalation the probes try,
 * so only a boundary can refuse one.
 */

import { LegacyStackSynthesizer, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { applyCellRolePath } from './cell-path';
import type { CellPolicyNames } from './cell-policies';
import { acknowledgeGranularFinding } from '../driver/nag';

export const PROBE_ROLES = {
  boundary: 'cell-policy-probe',
  workload: 'cell-policy-probe-workload',
  target: 'cell-policy-probe-target',
  tenant: 'cell-policy-probe-tenant',
} as const;

/** The stack tag of the probe stacks, so the account check and a leftover check can find them. */
export const PROBE_TAG = { key: 'stress:part', value: 'cell-policy-probe' } as const;

/** Every escalation the probes try, allowed on `*` so that only a boundary refuses. */
export const PROBE_ACTIONS = [
  'iam:*',
  'sts:AssumeRole',
  'lambda:CreateFunction',
  'lambda:DeleteFunction',
  'logs:PutDestination',
  'logs:DeleteDestination',
  'ssm:PutParameter',
  'ssm:DeleteParameter',
  'apigateway:PATCH',
] as const;

function probeRole(scope: Construct, id: string, roleName: string, description: string): iam.Role {
  const role = new iam.Role(scope, id, { roleName, assumedBy: new iam.AccountRootPrincipal(), description });
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
    const role = probeRole(this, 'BoundaryProbeRole', PROBE_ROLES.boundary, 'Stands in for the cell execution role; only the cell permissions boundary may refuse');
    iam.PermissionsBoundary.of(role).apply(iam.ManagedPolicy.fromManagedPolicyName(this, 'Boundary', props.names.boundary));
    applyCellRolePath(this);
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
