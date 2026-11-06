// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Teardown order (spec §6.2, M-26).
 *
 * The key drain runs on stack delete only after CloudFormation removed the
 * API and every function that can create or use a key: each of those
 * depends on the drain, and CloudFormation deletes dependents first.
 */

import { logicalIdOf, synthConstruct } from './helpers';

describe('stack-delete order (M-26)', () => {
  const { template } = synthConstruct();
  const drainId = logicalIdOf(template, 'Custom::TenantKeyDrain', '/Ingestion/KeyDrain/Default');
  const dependsOn = (type: string, path: string) => (template.toJSON().Resources[logicalIdOf(template, type, path)].DependsOn ?? []) as string[];

  it.each([
    ['AWS::ApiGateway::RestApi', '/Ingestion/Api/Resource'],
    ['AWS::Lambda::Function', '/Ingestion/KeyFactoryFunction/Resource'],
    ['AWS::Lambda::Function', '/Ingestion/PlatformFunction/Resource'],
    ['AWS::Lambda::Function', '/Ingestion/ProcessorFunction/Resource'],
    ['AWS::Lambda::Function', '/Ingestion/SweepFunction/Resource'],
  ])('%s %s is removed before the drain runs', (type, path) => {
    expect(dependsOn(type, path)).toContain(drainId);
  });

  it('the drain runs under platformRole', () => {
    const fn = template.toJSON().Resources[logicalIdOf(template, 'AWS::Lambda::Function', '/Ingestion/KeyDrainFunction/Resource')];
    expect(fn.Properties.Role['Fn::GetAtt'][0]).toBe(logicalIdOf(template, 'AWS::IAM::Role', '/Ingestion/PlatformRole/Resource'));
  });
});
