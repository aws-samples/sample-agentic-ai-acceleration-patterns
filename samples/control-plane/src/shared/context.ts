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
