// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Caller identity of the ingest door (spec §3.2, ADR-0001).
 *
 * API Gateway verifies the SigV4 signature and hands the function the
 * caller's ARN as `requestContext.identity.userArn`. Only an assumed role is
 * admitted; it is reduced to its role and account, and the role name must be
 * `<fleet>-ue-<cellId>`. Nothing in the request body is ever consulted.
 */

/** A cell id is a ULID (control-plane §4.2). */
const CELL_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** `<fleet>` follows the control plane's charset (spec §3.3). */
const FLEET = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** `arn:<partition>:sts::<account>:assumed-role/<role>/<session>` */
const ASSUMED_ROLE = /^arn:(aws[a-z-]*):sts::([0-9]{12}):assumed-role\/([A-Za-z0-9+=,.@_-]{1,64})\/[A-Za-z0-9+=,.@_-]{2,64}$/;

export interface EmitterCaller {
  readonly partition: string;
  readonly accountId: string;
  readonly roleName: string;
  readonly roleArn: string;
  /** The cell id the role name claims; the registry decides whether it is real. */
  readonly cellId: string;
}

/** The emitter role name for a cell (spec §3.4). At most 62 characters. */
export function emitterRoleName(fleet: string, cellId: string): string {
  if (!FLEET.test(fleet)) {
    throw new Error(`fleet name ${JSON.stringify(fleet)} is outside [a-z0-9][a-z0-9-]{0,31}`);
  }
  if (!CELL_ID.test(cellId)) {
    throw new Error(`cell id ${JSON.stringify(cellId)} is not a ULID`);
  }
  return `${fleet}-ue-${cellId}`;
}

/** The `aws:PrincipalArn` pattern the ingest route's resource policy admits. */
export function emitterRolePattern(fleet: string): string {
  if (!FLEET.test(fleet)) {
    throw new Error(`fleet name ${JSON.stringify(fleet)} is outside [a-z0-9][a-z0-9-]{0,31}`);
  }
  return `arn:aws:iam::*:role/${fleet}-ue-*`;
}

/**
 * Reduces a verified caller ARN to an emitter, or `undefined` when the caller
 * is not an assumed role named `<fleet>-ue-<cellId>`. An IAM user, a root
 * caller, a federated user or a role of another name is refused (spec §3.2).
 */
export function emitterFromCallerArn(userArn: string | undefined | null, fleet: string): EmitterCaller | undefined {
  if (userArn === undefined || userArn === null) {
    return undefined;
  }
  const match = ASSUMED_ROLE.exec(userArn);
  if (match === null) {
    return undefined;
  }
  const [, partition, accountId, roleName] = match;
  const prefix = `${fleet}-ue-`;
  if (!roleName.startsWith(prefix)) {
    return undefined;
  }
  const cellId = roleName.slice(prefix.length);
  if (!CELL_ID.test(cellId)) {
    return undefined;
  }
  return {
    partition,
    accountId,
    roleName,
    roleArn: `arn:${partition}:iam::${accountId}:role/${roleName}`,
    cellId,
  };
}

/** The registry key of an emitter (spec §4.2). */
export function emitterKey(accountId: string, roleName: string): { PK: string; SK: string } {
  return { PK: `EMITTER#${accountId}#${roleName}`, SK: 'META' };
}
