// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Cognito pre-token-generation trigger (V2) of the demo issuer (ADR-0009,
 * ADR-0013). It copies the user's immutable `custom:tenantId` attribute into
 * the access token's `tenant_id` claim, the repository token contract
 * (ARCHITECTURE.md §2.1). Cognito itself sets `sub`, `client_id`, and
 * `token_use: access`. A user without a tenant gets no token.
 *
 * The attribute is set by the vendor when it creates the user and no app
 * client may write it, so a caller cannot choose its tenant. Client metadata
 * is ignored.
 */

import type { PreTokenGenerationV2TriggerEvent } from 'aws-lambda';

/** A tenant id: one segment, no path, scope, or wildcard characters (M-2). */
export const TENANT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export async function handler(event: PreTokenGenerationV2TriggerEvent): Promise<PreTokenGenerationV2TriggerEvent> {
  const tenantId = event.request.userAttributes['custom:tenantId'];
  if (tenantId === undefined || !TENANT_ID_PATTERN.test(tenantId)) {
    // Thrown errors stop Cognito from issuing tokens; the message names no value.
    throw new Error('user has no valid tenant');
  }
  event.response = {
    claimsAndScopeOverrideDetails: {
      accessTokenGeneration: { claimsToAddOrOverride: { tenant_id: tenantId } },
      idTokenGeneration: { claimsToAddOrOverride: { tenant_id: tenantId } },
    },
  };
  return event;
}
