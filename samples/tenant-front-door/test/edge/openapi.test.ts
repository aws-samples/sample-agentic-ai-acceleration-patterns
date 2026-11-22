// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { allowEmptyBody, patchIntegrations, readRegistrarOpenApi } from '../../src/edge/openapi';

const URI = 'arn:aws:apigateway:eu-central-1:lambda:path/2015-03-31/functions/fn/invocations';

describe('registrar OpenAPI (spec §5.1)', () => {
  const doc = readRegistrarOpenApi() as any;

  it('points every operation at the registrar function', () => {
    const patched = patchIntegrations(doc, URI) as any;
    const integrations = Object.values(patched.paths).flatMap((item: any) => Object.values(item).map((op: any) => op['x-amazon-apigateway-integration']));
    expect(integrations).toHaveLength(6);
    for (const i of integrations) {
      expect(i).toEqual({ type: 'aws_proxy', httpMethod: 'POST', uri: URI });
    }
    expect(JSON.stringify(doc)).toContain('PLACEHOLDER');
  });

  it('fails when a PLACEHOLDER is left', () => {
    const odd = JSON.parse(JSON.stringify(doc));
    odd.paths['/cells/{cellId}'].put['x-amazon-apigateway-integration'].uri = 'PLACEHOLDER-2';
    expect(() => patchIntegrations(odd, URI)).toThrow(/PLACEHOLDER URI was not replaced/);
  });

  it('lets PutTenantRoute, whose body has no required member, be called with no body; the others keep full validation', () => {
    const out = allowEmptyBody(doc) as any;
    expect(out.paths['/tenants/{tenantId}'].put['x-amazon-apigateway-request-validator']).toBe('params-only');
    expect(out['x-amazon-apigateway-request-validators']['params-only']).toEqual({ validateRequestParameters: true, validateRequestBody: false });
    expect(out.paths['/cells/{cellId}'].put['x-amazon-apigateway-request-validator']).toBeUndefined();
    expect(out.paths['/tenants/{tenantId}/status'].put['x-amazon-apigateway-request-validator']).toBeUndefined();
    expect(out['x-amazon-apigateway-request-validator']).toBe('full');
  });

  it('keeps AWS_IAM on every operation (the document-level sigv4 requirement)', () => {
    expect(doc.security).toEqual([{ 'aws.auth.sigv4': [] }]);
    expect(doc.components.securitySchemes['aws.auth.sigv4']['x-amazon-apigateway-authtype']).toBe('awsSigv4');
  });
});
