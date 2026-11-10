// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/** The demo issuer's pre-token trigger (ADR-0003, ADR-0009, M-1). */

import type { PreTokenGenerationV2TriggerEvent } from 'aws-lambda';
import { handler } from '../src/issuer/pre-token.function';

function event(attributes: Record<string, string>, clientMetadata?: Record<string, string>): PreTokenGenerationV2TriggerEvent {
  return {
    version: '2',
    triggerSource: 'TokenGeneration_Authentication',
    region: 'us-west-2',
    userPoolId: 'us-west-2_example',
    userName: 'a-shopping',
    callerContext: { awsSdkVersion: 'x', clientId: 'demo-client' },
    request: { userAttributes: attributes, groupConfiguration: { groupsToOverride: [], iamRolesToOverride: [] }, scopes: [], clientMetadata },
    response: { claimsAndScopeOverrideDetails: {} },
  } as unknown as PreTokenGenerationV2TriggerEvent;
}

describe('pre-token trigger', () => {
  it('copies the immutable tenant attribute into tenant_id on the access token', async () => {
    const result = await handler(event({ 'sub': 'u-1', 'custom:tenantId': 'tenant-a' }));
    expect(result.response.claimsAndScopeOverrideDetails?.accessTokenGeneration?.claimsToAddOrOverride).toEqual({ tenant_id: 'tenant-a' });
  });

  it('ignores client metadata', async () => {
    const result = await handler(event({ 'custom:tenantId': 'tenant-a' }, { tenant_id: 'tenant-b' }));
    expect(result.response.claimsAndScopeOverrideDetails?.accessTokenGeneration?.claimsToAddOrOverride).toEqual({ tenant_id: 'tenant-a' });
  });

  it.each<Record<string, string>>([{}, { 'custom:tenantId': 'tenant-a/x' }, { 'custom:tenantId': 'tenant:a' }, { 'custom:tenantId': '*' }, { 'custom:tenantId': '' }])(
    'issues no token for a user without a valid tenant (%j)',
    async (attributes) => {
      await expect(handler(event(attributes))).rejects.toThrow('user has no valid tenant');
    },
  );
});
