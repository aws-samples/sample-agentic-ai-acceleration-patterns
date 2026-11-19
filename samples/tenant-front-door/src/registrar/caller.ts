// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { RegistrarConfig } from './config';

/**
 * The two roles the registrar admits (spec §3.4 step 1, ADR-0017):
 * - `hook`: the control plane's `<fleet>-global-hook` role in the control
 *   plane's account, under which the route hook runs;
 * - `operator`: the edge operator role the deployer names.
 *
 * The resource policy admits only these two by `aws:PrincipalArn` (spike
 * S-8); the function checks again from the signed request context and
 * refuses anything else, so a resource policy edit alone cannot widen who
 * writes routes.
 */
export type CallerRole = 'hook' | 'operator';

/** The parts of `requestContext.identity` the check reads. */
export interface CallerIdentity {
  readonly userArn?: string | null;
  readonly accountId?: string | null;
}

/** `arn:<partition>:sts::<account>:assumed-role/<role name>/<session>`. */
const ASSUMED_ROLE = /^arn:([a-z-]+):sts::(\d{12}):assumed-role\/([^/]+)\/[^/]+$/;

/** `arn:<partition>:iam::<account>:role/<path/><role name>`. */
const ROLE = /^arn:([a-z-]+):iam::(\d{12}):role\/(?:.*\/)?([^/]+)$/;

interface RoleId {
  readonly partition: string;
  readonly account: string;
  readonly name: string;
}

function parseRoleArn(arn: string): RoleId {
  const m = ROLE.exec(arn);
  if (m === null) throw new Error('not an IAM role ARN');
  return { partition: m[1], account: m[2], name: m[3] };
}

/**
 * Classifies a caller. An assumed-role session ARN names the role without
 * its path, so roles are compared by partition, account and name, which
 * IAM keeps unique in an account whatever the path. The hook role lives in
 * the edge operator role's partition. Returns undefined for any other
 * caller, an IAM user and a root session included.
 */
export function classifyCaller(identity: CallerIdentity | undefined, config: RegistrarConfig): CallerRole | undefined {
  const m = ASSUMED_ROLE.exec(identity?.userArn ?? '');
  if (m === null) return undefined;
  const [, partition, account, name] = m;
  if (identity?.accountId !== account) return undefined;
  const operator = parseRoleArn(config.edgeOperatorRoleArn);
  if (partition !== operator.partition) return undefined;
  if (account === operator.account && name === operator.name) return 'operator';
  if (account === config.controlPlaneAccount && name === `${config.fleet}-global-hook`) return 'hook';
  return undefined;
}
