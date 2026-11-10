// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The sample's published build-time interface (standard §1.1, §4.5): the
 * account role pair a cell-hosting account installs (spec R-25, ADR-025) and
 * the fleet naming it depends on. A consumer declares this sample as a local
 * dependency and imports from here; nothing else in src/ is a contract. The
 * control plane stack itself (`TenantStack`) is deployed from `main.ts` and
 * is not a construct other samples compose.
 */

export { CellAccountRoles, CellAccountStack } from './cell-account/cell-account.cdk';
export type { CellAccountRolesProps, CellAccountStackProps } from './cell-account/cell-account.cdk';
// The five physical role names derive from the fleet name (ADR-025, ADR-028).
export {
  DEFAULT_FLEET_NAME,
  EXTERNAL_ID_PATTERN,
  FLEET_NAME_PATTERN,
  apiRoleArn,
  apiRoleName,
  buildRoleArn,
  buildRoleName,
  provisioningRoleArn,
  provisioningRoleName,
  validateExternalId,
  validateFleetName,
} from './shared/fleet';
export type { ProvisioningRoleKind } from './shared/fleet';
// The SSM namespaces the pair grants (spec §6.2), for scripts and application planes that read them.
export * from './shared/ssm-namespaces';
