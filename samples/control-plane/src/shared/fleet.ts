// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Fleet naming (spec §3.3, §6.4, ADR-025, ADR-044). The `fleetName` names
 * seven IAM roles (the two hook roles of R-41 beside the five below), the
 * four shared build projects and the workflow with physical names. The
 * trust between the control plane and every account that hosts cells is
 * expressed by role NAME, not by a CloudFormation reference: the account
 * owner installs `<fleet>-cell-provisioning` / `<fleet>-tenant-provisioning`
 * trusting the control plane's `<fleet>-cell-build` / `<fleet>-tenant-build`
 * (the builds) and `<fleet>-api` (the PutAccount handshake probe, ADR-027),
 * and those roles may assume the provisioning roles by name in any account.
 * Project and workflow names make their ARNs computable before they exist,
 * so a role's trust and the stack's deny policy can name them without a
 * circular reference (R-41).
 * Shared by the CDK stacks (role creation, IAM resources) and the runtime
 * (role ARNs resolved into the workflow input, the PutAccount probe).
 */

/** Default fleet name when the deployment supplies none. */
export const DEFAULT_FLEET_NAME = 'control-plane';

/**
 * `[a-z0-9][a-z0-9-]{0,31}` (spec §3.3): lowercase keeps the IAM role names
 * (max 64 chars with the longest suffix) and the AssumeRole resource ARNs
 * predictable, and the first character is a letter or digit because the
 * fleet name also starts the CodeBuild project names and the state machine
 * name (R-41).
 */
export const FLEET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The two halves of the account role pair (spec §6.4). */
export type ProvisioningRoleKind = 'cell' | 'tenant';

/**
 * The session tags a build passes when it assumes its half of the pair
 * (ADR-0051), all transitive: a cell build tags its session with the cell,
 * a tenant build with the cell, the tenant and the application. The values
 * are the service-resolved `CELL_ID`, `TENANT_ID` and `APPLICATION_ID`.
 */
export const SESSION_TAG_KEYS: Readonly<Record<ProvisioningRoleKind, readonly string[]>> = {
  cell: ['CellId'],
  tenant: ['CellId', 'TenantId', 'ApplicationId'],
};

/**
 * The conditions on a build's `sts:AssumeRole` to its half of the pair
 * (ADR-0051), in the pair's trust: every tag of {@link SESSION_TAG_KEYS} is
 * present and no other key is passed. They make an untagged AssumeRole
 * fail, because STS evaluates `sts:TagSession` only when a request carries
 * tags. A `ForAllValues` condition alone is true for a request with no
 * tags, which is why the `Null` conditions are there.
 */
export function sessionTagRequestConditions(kind: ProvisioningRoleKind): Record<string, Record<string, string | string[]>> {
  const keys = [...SESSION_TAG_KEYS[kind]];
  return {
    'Null': Object.fromEntries(keys.map((key) => [`aws:RequestTag/${key}`, 'false'])),
    'ForAllValues:StringEquals': { 'aws:TagKeys': keys },
  };
}

/**
 * The conditions on a build's `sts:TagSession` to its half of the pair
 * (ADR-0051), used by the pair's trust and by the build role's own grant:
 * every tag of {@link SESSION_TAG_KEYS} is present, at least one key is
 * transitive, and no other key is passed or made transitive. They do not
 * require every key transitive: the buildspec makes all of them transitive,
 * and the threat model (M35) records the residual. The trust's TagSession
 * statement carries no `sts:ExternalId` condition: STS evaluates that key
 * on `sts:AssumeRole` only, and a TagSession statement that requires it
 * refuses every tagged request (shown by the integration test).
 */
export function sessionTagConditions(kind: ProvisioningRoleKind): Record<string, Record<string, string | string[]>> {
  const keys = [...SESSION_TAG_KEYS[kind]];
  return {
    'Null': {
      ...Object.fromEntries(keys.map((key) => [`aws:RequestTag/${key}`, 'false'])),
      'sts:TransitiveTagKeys': 'false',
    },
    'ForAllValues:StringEquals': {
      'aws:TagKeys': keys,
      'sts:TransitiveTagKeys': keys,
    },
  };
}

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

/**
 * The four shared CodeBuild projects (spec R-6, R-41): the two provisioning
 * projects and the two hook projects. Each project's name is its fleet name
 * plus this kind, so the project ARN can be computed before the project
 * exists (a hook role's trust names its project by `aws:SourceArn`, and the
 * stack's deny policy names all four).
 */
export type BuildProjectKind = 'cell-build' | 'tenant-build' | 'global-hook' | 'app-hook';

/** The four project kinds, in the order the spec lists them (R-6). */
export const BUILD_PROJECT_KINDS: readonly BuildProjectKind[] = ['cell-build', 'tenant-build', 'global-hook', 'app-hook'];

/** The two hook projects and the hook roles that run in them (spec R-41). */
export type HookRoleKind = 'global-hook' | 'app-hook';

/** Physical name of a shared build project: `<fleet>-<kind>` (spec §3.3). */
export function buildProjectName(fleetName: string, kind: BuildProjectKind): string {
  return `${fleetName}-${kind}`;
}

/** ARN of a shared build project (`arn:<p>:codebuild:<region>:<account>:project/<name>`). */
export function buildProjectArn(
  partition: string,
  region: string,
  accountId: string,
  fleetName: string,
  kind: BuildProjectKind,
): string {
  return `arn:${partition}:codebuild:${region}:${accountId}:project/${buildProjectName(fleetName, kind)}`;
}

/**
 * Name of a hook role, `<fleet>-global-hook` or `<fleet>-app-hook` (spec
 * R-41). No account role pair trusts either one.
 */
export function hookRoleName(fleetName: string, kind: HookRoleKind): string {
  return `${fleetName}-${kind}`;
}

/** ARN of a hook role in the control plane account. */
export function hookRoleArn(partition: string, controlPlaneAccountId: string, fleetName: string, kind: HookRoleKind): string {
  return `arn:${partition}:iam::${controlPlaneAccountId}:role/${hookRoleName(fleetName, kind)}`;
}

/** Physical name of the provisioning workflow, `<fleet>-workflow` (spec §3.3). */
export function workflowName(fleetName: string): string {
  return `${fleetName}-workflow`;
}

/** ARN of the provisioning workflow (the state machine). */
export function workflowArn(partition: string, region: string, accountId: string, fleetName: string): string {
  return `arn:${partition}:states:${region}:${accountId}:stateMachine:${workflowName(fleetName)}`;
}

/**
 * ARN pattern of the workflow's executions. Step Functions authorises
 * `states:RedriveExecution` on the execution ARN, not the state machine ARN
 * (spec R-41).
 */
export function workflowExecutionArnPattern(partition: string, region: string, accountId: string, fleetName: string): string {
  return `arn:${partition}:states:${region}:${accountId}:execution:${workflowName(fleetName)}:*`;
}

/** Throws with a clear message when the fleet name is outside {@link FLEET_NAME_PATTERN}. */
export function validateFleetName(fleetName: unknown): string {
  if (typeof fleetName !== 'string' || !FLEET_NAME_PATTERN.test(fleetName)) {
    throw new Error(
      `Invalid fleetName ${JSON.stringify(fleetName)}: expected 1-32 characters of [a-z0-9-], starting with a letter or digit (spec §3.3). `
      + 'It names the role pair every account installs (<fleetName>-cell-provisioning, <fleetName>-tenant-provisioning), '
      + 'the control plane build roles (<fleetName>-cell-build, <fleetName>-tenant-build), its API role (<fleetName>-api), '
      + 'its hook roles (<fleetName>-global-hook, <fleetName>-app-hook), the four build projects and the workflow (<fleetName>-workflow); '
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
