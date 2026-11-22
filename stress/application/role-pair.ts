// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The control-plane role pair of a cell account (spec §3.7; control-plane ADR-0025,
 * ADR-0047; stress ADR-0012): what the account owner passes to control-plane's
 * `CellAccountStack`. Pure, so the tests pin it without deploying.
 */

import { cellPolicyNames } from './cell-policies';

/** The fleet name pattern of control-plane (`src/shared/fleet.ts`). */
const FLEET = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ACCOUNT = /^\d{12}$/;
const PARTITION = /^aws(-[a-z]+)*$/;

export interface RolePairInput {
  /** The control plane's fleet name; the stress slice uses its prefix in lower case. */
  readonly fleetName: string;
  /** The platform account, where the control plane runs. */
  readonly controlPlaneAccountId: string;
  /** This cell account. */
  readonly cellAccountId: string;
  readonly partition?: string;
  /** `CELL_POLICY_SUFFIX` of the owner stacks. */
  readonly policySuffix?: string;
}

export interface RolePairProps {
  readonly stackName: string;
  readonly fleetName: string;
  readonly controlPlaneAccountId: string;
  readonly cellBuildManagedPolicyArns: string[];
  readonly tenantBuildManagedPolicyArns: string[];
}

/** The role pair's stack name: control-plane's `<fleet>-cell-account`. */
export const rolePairStackName = (fleetName: string): string => `${fleetName}-cell-account`;

/** The two role names of the pair (control-plane `provisioningRoleName`). */
export const rolePairRoleNames = (fleetName: string): readonly [string, string] => [
  `${fleetName}-cell-provisioning`,
  `${fleetName}-tenant-provisioning`,
];

/** The fleet name the control-plane slice uses for a stress prefix. */
export function fleetNameOf(prefix: string): string {
  const fleet = prefix.toLowerCase();
  if (!FLEET.test(fleet)) {
    throw new Error(`the prefix in lower case must match ${FLEET} to be a control-plane fleet name`);
  }
  return fleet;
}

/**
 * The props of the role pair: the cell role gets `cell-build-policy` (the deploy and
 * publishing `cdk-cell-*` roles only), the tenant role `cell-tenant-build-policy` (the
 * tenant subscription methods only). No external id: the cell accounts are vendor-owned
 * (control-plane ADR-0029).
 */
export function rolePairProps(input: RolePairInput): RolePairProps {
  if (!FLEET.test(input.fleetName)) throw new Error(`fleetName must match ${FLEET}`);
  if (!ACCOUNT.test(input.controlPlaneAccountId)) throw new Error('controlPlaneAccountId must be a 12-digit account id');
  if (!ACCOUNT.test(input.cellAccountId)) throw new Error('cellAccountId must be a 12-digit account id');
  if (input.controlPlaneAccountId === input.cellAccountId) {
    throw new Error('a cell account is never the platform account (spec §3.1)');
  }
  const partition = input.partition ?? 'aws';
  if (!PARTITION.test(partition)) throw new Error(`partition must match ${PARTITION}`);
  const names = cellPolicyNames(input.policySuffix ?? '');
  const arn = (name: string): string => `arn:${partition}:iam::${input.cellAccountId}:policy/${name}`;
  return {
    stackName: rolePairStackName(input.fleetName),
    fleetName: input.fleetName,
    controlPlaneAccountId: input.controlPlaneAccountId,
    cellBuildManagedPolicyArns: [arn(names.build)],
    tenantBuildManagedPolicyArns: [arn(names.tenantBuild)],
  };
}
