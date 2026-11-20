// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Node } from 'constructs';

/**
 * Reads an OPTIONAL context value given as a structured value (cdk.json) or
 * a JSON string (`--context key='[...]'`, `--context key=50`). Absent or
 * empty means undefined; structural validation happens in the stack. So
 * `--context concurrentBuildLimit=50` and a cdk.json `50` both arrive as the
 * number 50, while `'"50"'` stays a string and the stack refuses it.
 */
export function readJsonContext<T>(node: Node, key: string): T | undefined {
  const value = node.tryGetContext(key);
  if (value === undefined || value === '') {
    return undefined;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch (error) {
      throw new Error(`The ${key} context value is not valid JSON: ${(error as Error).message}`);
    }
  }
  return value as T;
}

/** The control plane stack's name when the deployer gives none. */
export const DEFAULT_STACK_NAME = 'control-plane-dev';

/** A CloudFormation stack name: a letter, then letters, digits and hyphens, at most 128 characters. */
const STACK_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,127}$/;

/**
 * Reads the OPTIONAL `stackName` context: the name of the control plane
 * stack, default `control-plane-dev`. A deployer who runs more than one
 * control plane in an account and Region, such as one per test run, names
 * each stack. Fails synthesis on a name CloudFormation would refuse.
 */
export function readStackName(node: Node): string {
  const value: unknown = node.tryGetContext('stackName');
  if (value === undefined || value === '') {
    return DEFAULT_STACK_NAME;
  }
  if (typeof value !== 'string' || !STACK_NAME_PATTERN.test(value)) {
    throw new Error(
      `Invalid stackName ${JSON.stringify(value)}: a CloudFormation stack name starts with a letter and holds letters, digits and hyphens, at most 128 characters`,
    );
  }
  return value;
}
