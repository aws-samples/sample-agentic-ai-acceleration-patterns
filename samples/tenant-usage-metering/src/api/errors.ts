// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The modelled errors of spec §5. The SSDK serialises an error by its
 * `name`, so the generated classes are thrown as they are. Messages are
 * fixed strings chosen here; no request body is echoed back.
 */

import {
  AccessDeniedException,
  ConflictException,
  type ConflictReason,
  InternalServerError,
  PayloadTooLargeException,
  ResourceNotFoundException,
  ValidationError,
} from '../smithy/metering/typescript-ssdk-codegen/src';

export const apiError = {
  validation: (message: string) => new ValidationError({ message }),
  accessDenied: (message = 'caller is not permitted for this route') => new AccessDeniedException({ message }),
  notFound: (message: string) => new ResourceNotFoundException({ message }),
  conflict: (reason: ConflictReason, message: string) => new ConflictException({ message, reason }),
  payloadTooLarge: () => new PayloadTooLargeException({ message: 'request body is over 1,048,576 bytes of UTF-8' }),
  internal: (message = 'internal error') => new InternalServerError({ message }),
};

/** Whether an error is one the SSDK serialises as a modelled response. */
export function isModelledError(error: unknown): boolean {
  return (
    error instanceof ValidationError ||
    error instanceof AccessDeniedException ||
    error instanceof ResourceNotFoundException ||
    error instanceof ConflictException ||
    error instanceof PayloadTooLargeException ||
    error instanceof InternalServerError
  );
}
