// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The key-policy builders, for construct-side users (the integration
 * test's scratch key, the README template). The implementation lives in
 * src/platform/key-policy.ts (M-17), because the key factory bundles it
 * into its Lambda; this module only re-exports it so the construct tree has
 * one import path.
 */

export {
  buildTenantKeyTemplate,
  buildVendorKeyPolicy,
  type PolicyDocument,
  type PolicyStatement,
  type TenantKeyTemplateInput,
  type VendorKeyPolicyInput,
} from '../platform/key-policy';
