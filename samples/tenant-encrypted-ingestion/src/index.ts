// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The published build-time interface (spec §6.3, standard §4.5): the
 * construct, its props, the validator contract, and the key-policy
 * builders a deployer needs for a `tenant-key` key's README template.
 */

export {
  DEFAULTS,
  type IdentityProps,
  type IngestionLogGroupName,
  type PipelineTiming,
  SUPPORTED_CONTENT_TYPES,
  TenantEncryptedIngestion,
  type TenantEncryptedIngestionProps,
  type TenantThrottleProps,
} from './tenant-encrypted-ingestion.cdk';
export { type IDeliveryValidator, LambdaValidator, type LambdaValidatorOptions } from './validators/lambda-validator';
export { buildTenantKeyTemplate, buildVendorKeyPolicy, type PolicyDocument } from './construct/key-policy';
export type { TenantRoles } from './construct/roles';
export type { IdentityApiProps } from './shared/scope-registration.cdk';
