// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The error model (spec §5.3, M-2). Both services throw these; the
 * generated SSDK serialisers pick an error by its `name`, so one class per
 * modelled shape name serves both. The Lambda wrapper then renders every
 * error response, modelled or not, as `{code, message, requestId}`.
 *
 * Messages are fixed strings chosen by the handler: no `tenantId` in a
 * `/tenant/*` error, never another tenant's key ARN, never input echoed back.
 */

import type { APIGatewayProxyResult } from 'aws-lambda';

export type ErrorShape =
  | 'ValidationError'
  | 'UnsupportedInTierError'
  | 'UnsupportedInDeploymentError'
  | 'ForbiddenError'
  | 'NotFoundError'
  | 'ConflictError'
  | 'TenantKeyUnavailableError'
  | 'KeyNotUsableError'
  | 'TooManyDeliveriesError'
  | 'InternalError';

/** The §5.3 `code` of each shape (`Forbidden` is this sample's addition for the 403). */
export const ERROR_CODES: Record<ErrorShape | 'ValidationException', string> = {
  ValidationException: 'ValidationError',
  ValidationError: 'ValidationError',
  UnsupportedInTierError: 'UnsupportedInTier',
  UnsupportedInDeploymentError: 'UnsupportedInDeployment',
  ForbiddenError: 'Forbidden',
  NotFoundError: 'NotFound',
  ConflictError: 'Conflict',
  TenantKeyUnavailableError: 'TenantKeyUnavailable',
  KeyNotUsableError: 'KeyNotUsable',
  TooManyDeliveriesError: 'TooManyDeliveries',
  InternalError: 'InternalError',
};

const FAULT: Record<ErrorShape, 'client' | 'server'> = {
  ValidationError: 'client',
  UnsupportedInTierError: 'client',
  UnsupportedInDeploymentError: 'client',
  ForbiddenError: 'client',
  NotFoundError: 'client',
  ConflictError: 'client',
  TenantKeyUnavailableError: 'client',
  KeyNotUsableError: 'client',
  TooManyDeliveriesError: 'client',
  InternalError: 'server',
};

/** A modelled error. `name` is the Smithy shape name the SSDK serialises by. */
export class ApiError extends Error {
  readonly $fault: 'client' | 'server';
  constructor(readonly shape: ErrorShape, message: string) {
    super(message);
    this.name = shape;
    this.$fault = FAULT[shape];
  }
}

export const apiError = {
  validation: (message: string) => new ApiError('ValidationError', message),
  unsupportedInTier: (message: string) => new ApiError('UnsupportedInTierError', message),
  unsupportedInDeployment: (message: string) => new ApiError('UnsupportedInDeploymentError', message),
  forbidden: (message: string) => new ApiError('ForbiddenError', message),
  notFound: (message: string) => new ApiError('NotFoundError', message),
  conflict: (message: string) => new ApiError('ConflictError', message),
  tenantKeyUnavailable: (message: string) => new ApiError('TenantKeyUnavailableError', message),
  keyNotUsable: (message: string) => new ApiError('KeyNotUsableError', message),
  tooManyDeliveries: (message: string) => new ApiError('TooManyDeliveriesError', message),
  internal: (message = 'internal error') => new ApiError('InternalError', message),
};

/**
 * Rewrites an error response to `{code, message, requestId}`. A framework
 * exception (SSDK validation, unknown operation, an unexpected throw) maps
 * to `ValidationError` for a 4xx and `InternalError` for a 5xx; its own
 * message is kept only for SSDK input validation, which names the failing
 * member and never its value.
 */
export function normaliseErrorResponse(response: APIGatewayProxyResult, requestId: string): APIGatewayProxyResult {
  if (response.statusCode < 400) {
    return response;
  }
  const single = Object.entries(response.headers ?? {}).find(([k]) => k.toLowerCase() === 'x-amzn-errortype')?.[1];
  const multi = Object.entries(response.multiValueHeaders ?? {}).find(([k]) => k.toLowerCase() === 'x-amzn-errortype')?.[1]?.[0];
  const typeHeader = single ?? multi;
  const type = typeof typeHeader === 'string' ? typeHeader.split(':')[0] : '';
  let message = response.statusCode >= 500 ? 'internal error' : 'invalid request';
  let code = ERROR_CODES[type as ErrorShape] ?? (response.statusCode >= 500 ? 'InternalError' : 'ValidationError');
  if (code !== 'InternalError') {
    try {
      const body = JSON.parse(response.body ?? '{}') as { message?: unknown };
      if (typeof body.message === 'string') {
        message = body.message;
      }
    } catch {
      // keep the fixed message
    }
  } else {
    code = 'InternalError';
  }
  return {
    statusCode: response.statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, message, requestId }),
  };
}
