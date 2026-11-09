// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * cdk-nag `AwsSolutionsChecks` (N-7, M-31): the construct alone, once with
 * every option on and once with the optional roles and validators, and the
 * demo stack, raise no unacknowledged error.
 */

import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { importedRole, synthConstruct, validatorFor } from './helpers';
import { parseDemoContext, TenantEncryptedIngestionDemoStack } from '../src/demo.cdk';

describe('cdk-nag', () => {
  it('passes for the construct with every option on', () => {
    expect(() =>
      synthConstruct({ allowTenantKeys: true, tenantThrottle: { rateLimit: 10, burstLimit: 20 }, perTenantMetrics: true }, true),
    ).not.toThrow();
  });

  it('passes with validators, consumer roles, a redrive operator and an access-log reader', () => {
    expect(() =>
      synthConstruct(
        (stack) => ({
          validators: [validatorFor(stack, 'pdf-pages')],
          consumerRoles: [importedRole(stack, 'Consumer', 'extraction-consumer')],
          redriveOperatorRole: importedRole(stack, 'Operator', 'redrive-operator'),
          accessLogReaderRole: importedRole(stack, 'Reader', 'log-reader'),
        }),
        true,
      ),
    ).not.toThrow();
  });

  it('passes for the demo stack', () => {
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
    new TenantEncryptedIngestionDemoStack(app, 'Demo', {
      context: parseDemoContext((k) => ({ identityParameterPlaceholders: 'true', integProfile: 'true', allowTenantKeys: 'true' })[k]),
      env: { account: '111122223333', region: 'eu-central-1' },
    });
    expect(() => app.synth()).not.toThrow();
  });
});
