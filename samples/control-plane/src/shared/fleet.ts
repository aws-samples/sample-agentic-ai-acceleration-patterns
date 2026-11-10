// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Fleet naming (spec §3.3, §6.4, ADR-025). The `fleetName` names five IAM
 * roles with physical names, because the trust between the control plane
 * and every account that hosts cells is expressed by role NAME, not by a
 * CloudFormation reference: the account owner installs
 * `<fleet>-cell-provisioning` / `<fleet>-tenant-provisioning` trusting the
 * control plane's `<fleet>-cell-build` / `<fleet>-tenant-build` (the builds)
 * and `<fleet>-api` (the PutAccount handshake probe, ADR-027), and those
 * roles may assume the provisioning roles by name in any account.
 * Shared by the CDK stacks (role creation, IAM resources) and the runtime
 * (role ARNs resolved into the workflow input, the PutAccount probe).
 */

/** Default fleet name when the deployment supplies none. */
export const DEFAULT_FLEET_NAME = 'control-plane';

/**
 * `[a-z0-9-]{1,32}`: lowercase keeps the IAM role names (max 64 chars with
 * the longest suffix) and the AssumeRole resource ARNs predictable.
 */
export const FLEET_NAME_PATTERN = /^[a-z0-9-]{1,32}$/;

/** The two halves of the account role pair (spec §6.4). */
export type ProvisioningRoleKind = 'cell' | 'tenant';

/** Name of the provisioning role an account installs for one half of the pair. */
export function provisioningRoleName(fleetName: string, kind: ProvisioningRoleKind): string {
  return `${fleetName}-${kind}-provisioning`;
}

/** Name of the control plane's build role for one half of the pair. */
export function buildRoleName(fleetName: string, kind: ProvisioningRoleKind): string {
  return `${fleetName}-${kind}-build`;
}

/**
 * Name of the control plane's API function role, `<fleet>-api`. The account
 * role pair trusts it too, for the PutAccount handshake probe (ADR-027,
 * ADR-028): the probe is the control plane assuming the pair, so the owner's
 * trust names the role that does it.
 */
export function apiRoleName(fleetName: string): string {
  return `${fleetName}-api`;
}

/** ARN of the control plane's API function role in the control plane account. */
export function apiRoleArn(partition: string, controlPlaneAccountId: string, fleetName: string): string {
  return `arn:${partition}:iam::${controlPlaneAccountId}:role/${apiRoleName(fleetName)}`;
}

/** ARN of a provisioning role in a given account (`*` for "any account", N-8). */
export function provisioningRoleArn(
  partition: string,
  accountId: string,
  fleetName: string,
  kind: ProvisioningRoleKind,
): string {
  return `arn:${partition}:iam::${accountId}:role/${provisioningRoleName(fleetName, kind)}`;
}

/** ARN of a control-plane build role in the control plane account. */
export function buildRoleArn(
  partition: string,
  controlPlaneAccountId: string,
  fleetName: string,
  kind: ProvisioningRoleKind,
): string {
  return `arn:${partition}:iam::${controlPlaneAccountId}:role/${buildRoleName(fleetName, kind)}`;
}

/** Throws with a clear message when the fleet name is outside {@link FLEET_NAME_PATTERN}. */
export function validateFleetName(fleetName: unknown): string {
  if (typeof fleetName !== 'string' || !FLEET_NAME_PATTERN.test(fleetName)) {
    throw new Error(
      `Invalid fleetName ${JSON.stringify(fleetName)}: expected 1-32 characters of [a-z0-9-] (spec §3.3). `
      + 'It names the role pair every account installs (<fleetName>-cell-provisioning, <fleetName>-tenant-provisioning), '
      + 'the control plane build roles (<fleetName>-cell-build, <fleetName>-tenant-build) and its API role (<fleetName>-api); '
      + 'two control planes in one account need different fleet names.',
    );
  }
  return fleetName;
}

/** STS's `ExternalId` constraint (spec §3.3 and §6.4): 2-1224 characters of `[\w+=,.@:/-]`. */
export const EXTERNAL_ID_PATTERN = /^[\w+=,.@:/-]{2,1224}$/;

/**
 * Throws with a clear message when an external id would be refused by STS.
 * Caught at synth so a customer does not install a pair whose trust policy
 * no AssumeRole call can ever satisfy.
 */
export function validateExternalId(externalId: unknown): string {
  if (typeof externalId !== 'string' || !EXTERNAL_ID_PATTERN.test(externalId)) {
    throw new Error(
      `Invalid externalId ${JSON.stringify(externalId)}: expected 2-1224 characters of [\\w+=,.@:/-] (spec §3.3). `
      + 'STS refuses any other value, so the role pair could never be assumed. '
      + 'Tenant-owned accounts must set one (spec §6.4, ADR-029).',
    );
  }
  return externalId;
}

/**
 * The AssumeRole session name (M23): the verified operator id, so the
 * account owner's CloudTrail attributes provisioning to the operator.
 * STS allows `[\w+=,.@-]{2,64}`; anything else in a JWT `sub` (an IdP
 * prefix such as `auth0|`) is replaced, and the name is clamped.
 */
export function sessionNameFor(operatorId: string): string {
  const cleaned = operatorId.replace(/[^\w+=,.@-]/g, '-').slice(0, 64);
  return cleaned.length >= 2 ? cleaned : `op-${cleaned}`;
}
