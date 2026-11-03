// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { TOOLS_ENV } from '../../src/tools/transaction-token';

/**
 * Integ run 7: the RESPONSE filter imported interceptor.function.ts, whose
 * load-time dependency build requires RI_CONTEXT_KEY_ID; the filter's
 * environment (verifierEnv) does not hold the context key, so it died at init
 * and every finance response was a 500. Load it as Lambda would, with only its
 * own variables.
 */
describe('RESPONSE filter cold start', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  test('loads in Lambda with the verifier variables only (no context key)', () => {
    process.env = {
      ...saved,
      AWS_LAMBDA_FUNCTION_NAME: 'response-filter',
      AWS_REGION: 'eu-central-1',
      [TOOLS_ENV.ISSUER]: 'https://example.execute-api.eu-central-1.amazonaws.com/prod',
      [TOOLS_ENV.INGRESS_ROLE_ARN]: 'arn:aws:iam::111122223333:role/IngressRole',
      [TOOLS_ENV.GATEWAY_NAME]: 'finance',
    };
    delete process.env[TOOLS_ENV.CONTEXT_KEY_ID];
    expect(() => {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../../src/tools/response-filter.function');
      });
    }).not.toThrow();
  });

  test('the interceptor itself still fails at cold start without its context key', () => {
    process.env = {
      ...saved,
      AWS_LAMBDA_FUNCTION_NAME: 'interceptor',
      AWS_REGION: 'eu-central-1',
      [TOOLS_ENV.ISSUER]: 'https://example.execute-api.eu-central-1.amazonaws.com/prod',
      [TOOLS_ENV.INGRESS_ROLE_ARN]: 'arn:aws:iam::111122223333:role/IngressRole',
      [TOOLS_ENV.GATEWAY_NAME]: 'finance',
    };
    delete process.env[TOOLS_ENV.CONTEXT_KEY_ID];
    expect(() => {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../../src/tools/interceptor.function');
      });
    }).toThrow(/RI_CONTEXT_KEY_ID/);
  });
});
