// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The few responses a function writes before the SSDK sees the request:
 * the restJson1 error shape, `X-Amzn-ErrorType` naming the modelled error.
 */

import type { APIGatewayProxyResult } from 'aws-lambda';

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
