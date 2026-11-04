// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * (ADR-0042) A `PublishedIngress` document and the context key
 * `SharedIngress.fromParameters` looks it up under, for tests that import an
 * ingress from another stack. Every identifier is invented.
 */

import type { App } from 'aws-cdk-lib';
import type { IngressKind } from '../src/shared/metrics';
import { DEFAULT_REGISTRY_PREFIX, PUBLISHED, type PublishedIngress, type PublishedToolsGateway } from '../src/shared-ingress.cdk';

export const TEST_ACCOUNT = '111122223333';
export const TEST_REGION = 'eu-central-1';
export const TEST_ENV = { account: TEST_ACCOUNT, region: TEST_REGION } as const;

/** The context key of the `valueFromLookup` for `<prefix>ingress`. */
export function lookupKey(prefix: string = DEFAULT_REGISTRY_PREFIX, account = TEST_ACCOUNT, region = TEST_REGION): string {
  return `ssm:account=${account}:parameterName=${prefix}${PUBLISHED.ingress}:region=${region}`;
}

function gateway(name: string): PublishedToolsGateway {
  return {
    url: `https://gw-${name}.gateway.bedrock-agentcore.${TEST_REGION}.amazonaws.com/mcp`,
    identifier: `gw-${name}-abc123`,
    roleArn: `arn:aws:iam::${TEST_ACCOUNT}:role/ri-tools-gateway-${name}`,
    policyEngineId: `pe-${name}-abc123`,
  };
}

/** A version 2 document for `ingress`, with the named tools gateways (default `['default']`). */
export function publishedIngress(ingress: IngressKind, gateways: readonly string[] = ['default']): PublishedIngress {
  const base = `https://abc123.execute-api.${TEST_REGION}.amazonaws.com/prod`;
  return {
    version: 2,
    ingress,
    endpointUrl: `${base}/invocations`,
    baseUrl: base,
    ingressRoleArn: `arn:aws:iam::${TEST_ACCOUNT}:role/ri-ingress-role`,
    ingressId: 'ri-ingress-abc123',
    tenantRoleArn: `arn:aws:iam::${TEST_ACCOUNT}:role/ri-tenant-model-role`,
    ...(ingress === 'agentcore-gateway' ? { gatewayIdentifier: 'ri-gateway-abc123' } : {}),
    issuer: 'https://issuer.execute-api.eu-central-1.amazonaws.com/prod',
    jwksUrl: 'https://issuer.execute-api.eu-central-1.amazonaws.com/prod/.well-known/jwks.json',
    entitlementsTableName: 'ri-entitlements-abc123',
    entitlementsApiUrl: 'https://issuer.execute-api.eu-central-1.amazonaws.com/prod/entitlements',
    ...(gateways.length > 0 ? { toolContextKeyId: '00000000-1111-2222-3333-444444444444' } : {}),
    toolsGateways: Object.fromEntries(gateways.map((g) => [g, gateway(g)])),
  };
}

/** Seeds the lookup context of `app` with `doc` (anything JSON-serialisable, to test the version check). */
export function seedPublishedIngress(app: App, doc: unknown, prefix: string = DEFAULT_REGISTRY_PREFIX): void {
  app.node.setContext(lookupKey(prefix), JSON.stringify(doc));
}
