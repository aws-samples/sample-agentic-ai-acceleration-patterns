// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  apiRoleArn,
  apiRoleName,
  BUILD_PROJECT_KINDS,
  buildProjectArn,
  buildProjectName,
  buildRoleArn,
  buildRoleName,
  DEFAULT_FLEET_NAME,
  hookRoleArn,
  hookRoleName,
  provisioningRoleArn,
  provisioningRoleName,
  sessionNameFor,
  validateExternalId,
  validateFleetName,
  workflowArn,
  workflowExecutionArnPattern,
  workflowName,
} from '../../src/shared/fleet';

describe('fleet role naming (spec §3.3 / §6.4, ADR-025)', () => {
  test('the five role names derive from the fleet name (ADR-025, ADR-028)', () => {
    expect(provisioningRoleName('control-plane', 'cell')).toBe('control-plane-cell-provisioning');
    expect(provisioningRoleName('control-plane', 'tenant')).toBe('control-plane-tenant-provisioning');
    expect(buildRoleName('control-plane', 'cell')).toBe('control-plane-cell-build');
    expect(buildRoleName('control-plane', 'tenant')).toBe('control-plane-tenant-build');
    expect(apiRoleName('control-plane')).toBe('control-plane-api');
    expect(apiRoleArn('aws', '111111111111', 'control-plane')).toBe('arn:aws:iam::111111111111:role/control-plane-api');
  });

  test('role ARNs carry the partition and account; `*` stands for any account (N-8)', () => {
    expect(provisioningRoleArn('aws', '111111111111', 'fleet-a', 'cell')).toBe(
      'arn:aws:iam::111111111111:role/fleet-a-cell-provisioning',
    );
    expect(provisioningRoleArn('aws-cn', '*', 'fleet-a', 'tenant')).toBe(
      'arn:aws-cn:iam::*:role/fleet-a-tenant-provisioning',
    );
    expect(buildRoleArn('aws', '999999999999', 'fleet-a', 'tenant')).toBe(
      'arn:aws:iam::999999999999:role/fleet-a-tenant-build',
    );
  });

  test('validateFleetName accepts [a-z0-9][a-z0-9-]{0,31} and rejects the rest with a clear message', () => {
    expect(validateFleetName(DEFAULT_FLEET_NAME)).toBe('control-plane');
    expect(validateFleetName('a')).toBe('a');
    expect(validateFleetName('9-fleet')).toBe('9-fleet');
    expect(validateFleetName('x'.repeat(32))).toBe('x'.repeat(32));
    // A CodeBuild project name must start with a letter or digit (spec §3.3).
    for (const bad of ['', '-fleet', '-', 'Control-Plane', 'has_underscore', 'x'.repeat(33), 42, undefined]) {
      expect(() => validateFleetName(bad)).toThrow(/Invalid fleetName/);
    }
  });

  test('the four project names, the two hook roles and the workflow derive from the fleet name (R-41, §3.3)', () => {
    expect(BUILD_PROJECT_KINDS.map((kind) => buildProjectName('fleet-a', kind))).toEqual([
      'fleet-a-cell-build',
      'fleet-a-tenant-build',
      'fleet-a-global-hook',
      'fleet-a-app-hook',
    ]);
    // A provisioning project carries the name of its build role.
    expect(buildProjectName('fleet-a', 'cell-build')).toBe(buildRoleName('fleet-a', 'cell'));
    expect(buildProjectName('fleet-a', 'tenant-build')).toBe(buildRoleName('fleet-a', 'tenant'));
    expect(hookRoleName('fleet-a', 'global-hook')).toBe('fleet-a-global-hook');
    expect(hookRoleName('fleet-a', 'app-hook')).toBe('fleet-a-app-hook');
    expect(workflowName('fleet-a')).toBe('fleet-a-workflow');
  });

  test('project, hook role, workflow and execution ARNs are computable from names alone (R-41)', () => {
    expect(buildProjectArn('aws', 'eu-central-1', '111111111111', 'fleet-a', 'app-hook')).toBe(
      'arn:aws:codebuild:eu-central-1:111111111111:project/fleet-a-app-hook',
    );
    expect(hookRoleArn('aws-cn', '111111111111', 'fleet-a', 'global-hook')).toBe(
      'arn:aws-cn:iam::111111111111:role/fleet-a-global-hook',
    );
    expect(workflowArn('aws', 'eu-central-1', '111111111111', 'fleet-a')).toBe(
      'arn:aws:states:eu-central-1:111111111111:stateMachine:fleet-a-workflow',
    );
    expect(workflowExecutionArnPattern('aws', 'eu-central-1', '111111111111', 'fleet-a')).toBe(
      'arn:aws:states:eu-central-1:111111111111:execution:fleet-a-workflow:*',
    );
  });

  test('the longest fleet name keeps every derived physical name inside its service limit', () => {
    const fleet = 'x'.repeat(32);
    // IAM role names: 64; the longest is the tenant provisioning role.
    expect(provisioningRoleName(fleet, 'tenant').length).toBeLessThanOrEqual(64);
    expect(hookRoleName(fleet, 'global-hook').length).toBeLessThanOrEqual(64);
    // State machine names: 80.
    expect(workflowName(fleet).length).toBeLessThanOrEqual(80);
  });

  test('validateExternalId accepts the STS ExternalId pattern and rejects the rest (§3.3, ADR-029)', () => {
    expect(validateExternalId('ab')).toBe('ab');
    expect(validateExternalId('customer-handshake_1:v2/x+y=z,w.@')).toBe('customer-handshake_1:v2/x+y=z,w.@');
    expect(validateExternalId('x'.repeat(1224))).toBe('x'.repeat(1224));
    for (const bad of ['', 'a', 'has space', 'tab\tchar', 'uni©ode', 'x'.repeat(1225), 42, undefined]) {
      expect(() => validateExternalId(bad)).toThrow(/Invalid externalId/);
    }
  });
});

describe('sessionNameFor (M23: the operator id as the STS session name)', () => {
  test('passes a plain subject through unchanged', () => {
    expect(sessionNameFor('6f4a2c1e-0b7d-4c4e-9a1f-2d3e4f5a6b7c')).toBe('6f4a2c1e-0b7d-4c4e-9a1f-2d3e4f5a6b7c');
  });

  test('replaces characters STS does not allow and clamps to 64', () => {
    expect(sessionNameFor('auth0|abc')).toBe('auth0-abc');
    expect(sessionNameFor('a'.repeat(100))).toHaveLength(64);
  });

  test('pads a subject shorter than the STS minimum of two characters', () => {
    expect(sessionNameFor('x')).toBe('op-x');
    expect(sessionNameFor('')).toBe('op-');
  });
});
