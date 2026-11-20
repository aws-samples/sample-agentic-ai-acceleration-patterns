// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Exact decimal arithmetic at 6 fractional digits (spec §4.8, §4.9).
 *
 * A usage value is a non-negative decimal string with at most 12 digits
 * before the point and 6 after. Values are held as integer micro-units in a
 * `bigint`, so sums are exact and never pass through a float.
 */

export const SCALE = 6;
const FACTOR = 10n ** BigInt(SCALE);
const VALUE = /^([0-9]{1,12})(?:\.([0-9]{1,6}))?$/;

/** Parses a usage value into micro-units; throws on anything else. */
export function parseValue(value: string): bigint {
  const match = VALUE.exec(value);
  if (match === null) {
    throw new RangeError(`value ${JSON.stringify(value)} is not a decimal with at most 12 integer and 6 fractional digits`);
  }
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? '').padEnd(SCALE, '0'));
  return whole * FACTOR + fraction;
}

/** True when `value` is a valid usage value. */
export function isValue(value: string): boolean {
  return VALUE.test(value);
}

/** Renders micro-units as a decimal string, without trailing zeros. */
export function formatMicros(micros: bigint): string {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const whole = abs / FACTOR;
  const fraction = (abs % FACTOR).toString().padStart(SCALE, '0').replace(/0+$/, '');
  const body = fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`;
  return negative ? `-${body}` : body;
}

/** Parses a quantity as the table stores it (may be negative, spec §4.7). */
export function parseQuantity(quantity: string): bigint {
  const negative = quantity.startsWith('-');
  const micros = parseValue(negative ? quantity.slice(1) : quantity);
  return negative ? -micros : micros;
}

/** Micro-units for an integer count. */
export function countMicros(count: number | bigint): bigint {
  return BigInt(count) * FACTOR;
}
