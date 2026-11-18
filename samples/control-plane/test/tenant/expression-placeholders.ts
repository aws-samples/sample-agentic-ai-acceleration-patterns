// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * DynamoDB refuses an `UpdateItem` whose `ExpressionAttributeNames` or
 * `ExpressionAttributeValues` hold a placeholder no expression uses, and one
 * whose expressions use a placeholder neither map defines. Asserts both for
 * a built update, so a builder test catches what only a live call would.
 */
export function expectPlaceholdersMatch(update: {
  readonly updateExpression: string;
  readonly conditionExpression?: string;
  readonly expressionAttributeNames?: Record<string, string>;
  readonly expressionAttributeValues?: Record<string, unknown>;
}): void {
  const text = `${update.updateExpression} ${update.conditionExpression ?? ''}`;
  const used = (prefix: string) => new Set(text.match(new RegExp(`${prefix}[A-Za-z0-9_]+`, 'g')) ?? []);
  expect([...used('#')].sort()).toEqual(Object.keys(update.expressionAttributeNames ?? {}).sort());
  expect([...used(':')].sort()).toEqual(Object.keys(update.expressionAttributeValues ?? {}).sort());
}
