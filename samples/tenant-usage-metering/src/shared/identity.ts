// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Caller identity of the ingest door (spec §3.2, ADR-0001).
 *
 * API Gateway verifies the SigV4 signature and hands the function the
 * caller's ARN as `requestContext.identity.userArn`. Only an assumed role is
 * admitted; it is reduced to its role and account, and the role name must be
 * `<fleet>-ue-<emitterId>`. Nothing in the request body is ever consulted.
 */

/** An emitter id is a ULID (spec §4.2). */
const EMITTER_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** `<fleet>` follows the control plane's charset (spec §3.3). */
const FLEET = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** `arn:<partition>:sts::<account>:assumed-role/<role>/<session>` */
const ASSUMED_ROLE = /^arn:(aws[a-z-]*):sts::([0-9]{12}):assumed-role\/([A-Za-z0-9+=,.@_-]{1,64})\/[A-Za-z0-9+=,.@_-]{2,64}$/;

export interface EmitterCaller {
  readonly partition: string;
  readonly accountId: string;
  readonly roleName: string;
  readonly roleArn: string;
  /** The emitter id the role name claims; the registry decides whether it is real. */
  readonly emitterId: string;
}

/** The role name of an emitter (spec §3.4). At most 62 characters. */
export function emitterRoleName(fleet: string, emitterId: string): string {
  if (!FLEET.test(fleet)) {
    throw new Error(`fleet name ${JSON.stringify(fleet)} is outside [a-z0-9][a-z0-9-]{0,31}`);
  }
  if (!EMITTER_ID.test(emitterId)) {
    throw new Error(`emitter id ${JSON.stringify(emitterId)} is not a ULID`);
  }
  return `${fleet}-ue-${emitterId}`;
}

/**
 * The `aws:PrincipalArn` pattern the ingest route's resource policy admits.
 * `partition` is the stack's partition (`Aws.PARTITION` at synth), so the
 * pattern matches what `ASSUMED_ROLE` accepts at run time in any `aws*`
 * partition.
 */
export function emitterRolePattern(fleet: string, partition: string): string {
  if (!FLEET.test(fleet)) {
    throw new Error(`fleet name ${JSON.stringify(fleet)} is outside [a-z0-9][a-z0-9-]{0,31}`);
  }
  return `arn:${partition}:iam::*:role/${fleet}-ue-*`;
}

/**
 * Reduces a verified caller ARN to an emitter, or `undefined` when the caller
 * is not an assumed role named `<fleet>-ue-<emitterId>`. An IAM user, a root
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
  const emitterId = roleName.slice(prefix.length);
  if (!EMITTER_ID.test(emitterId)) {
    return undefined;
  }
  return {
    partition,
    accountId,
    roleName,
    roleArn: `arn:${partition}:iam::${accountId}:role/${roleName}`,
    emitterId,
  };
}

/** The role-keyed registry item of an emitter, `ROLE#<account>#<role>` (spec §4.2). */
export function emitterRoleKey(accountId: string, roleName: string): { PK: string; SK: string } {
  return { PK: `ROLE#${accountId}#${roleName}`, SK: 'META' };
}

/** An assumed-role caller reduced to its role (any role name). */
export interface RoleCaller {
  readonly accountId: string;
  readonly roleName: string;
  /** `arn:<partition>:iam::<account>:role/<name>`, without the role's path. */
  readonly roleArn: string;
}

/** Reduces a verified caller ARN to its role, or `undefined` for any other kind of caller. */
export function roleFromCallerArn(userArn: string | undefined | null): RoleCaller | undefined {
  if (userArn === undefined || userArn === null) {
    return undefined;
  }
  const match = ASSUMED_ROLE.exec(userArn);
  if (match === null) {
    return undefined;
  }
  const [, partition, accountId, roleName] = match;
  return { accountId, roleName, roleArn: `arn:${partition}:iam::${accountId}:role/${roleName}` };
}

/**
 * Whether a caller is one of the listed role ARNs. An assumed-role ARN
 * carries no role path, so a listed ARN matches on account and the last
 * segment of its name.
 */
export function callerIsListed(caller: RoleCaller, roleArns: ReadonlyArray<string>): boolean {
  return roleArns.some((arn) => {
    const match = /^arn:aws[a-z-]*:iam::([0-9]{12}):role\/(?:.*\/)?([^/]+)$/.exec(arn);
    return match !== null && match[1] === caller.accountId && match[2] === caller.roleName;
  });
}
