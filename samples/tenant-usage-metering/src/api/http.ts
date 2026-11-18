// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The few responses a function writes before the SSDK sees the request:
 * the restJson1 error shape, `X-Amzn-ErrorType` naming the modelled error.
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

export function errorResponse(statusCode: number, errorType: string, message: string): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'X-Amzn-ErrorType': errorType },
    body: JSON.stringify({ message }),
  };
}

/** The request body size in bytes, as the emitter encoded it (spec §5.1). */
export function bodyBytes(body: string | null | undefined, isBase64Encoded: boolean): number {
  if (body === null || body === undefined) {
    return 0;
  }
  return isBase64Encoded ? Buffer.from(body, 'base64').length : Buffer.byteLength(body, 'utf8');
}

/**
 * The event with lowercase header names. API Gateway keeps the client's
 * casing (`X-Control-Plane-Execution-Id`), and the SSDK's deserialisers read
 * modelled headers by their lowercase names, so a header sent in another
 * case was dropped (pg, 2026-11-18).
 */
export function lowercaseHeaders(event: APIGatewayProxyEvent): APIGatewayProxyEvent {
  const lower = <T>(headers: Record<string, T> | null | undefined): Record<string, T> =>
    Object.fromEntries(Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
  return { ...event, headers: lower(event.headers), multiValueHeaders: lower(event.multiValueHeaders) };
}
