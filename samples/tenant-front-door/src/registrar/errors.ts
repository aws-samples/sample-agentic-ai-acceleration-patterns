// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  BadRequestError,
  CertificateQuotaError,
  ConflictError,
  ForbiddenError,
  InsufficientStorageError,
  InternalServerError,
  ServiceUnavailableError,
  TooManyRequestsReason,
  UnprocessableError,
} from '../smithy/source/typescript-ssdk-codegen/src';

/**
 * The registrar's refusals (spec §5.1). Messages are fixed strings that
 * name the rule, never another tenant, account or cell, and never echo a
 * control-plane value the caller did not send.
 */
export const refuse = {
  badRequest: (message: string) => new BadRequestError({ message }),
  forbidden: (message: string) => new ForbiddenError({ message }),
  conflict: (message: string) => new ConflictError({ message }),
  unprocessable: (message: string) => new UnprocessableError({ message }),
  /** ACM refused the certificate request for its quota: 429 with `reason: certificate-quota` (§4.1). */
  certificateQuota: () => new CertificateQuotaError({
    message: 'ACM refused the certificate request for its certificate quota',
    reason: TooManyRequestsReason.CERTIFICATE_QUOTA,
  }),
  unavailable: (message: string) => new ServiceUnavailableError({ message }),
  storage: () => new InsufficientStorageError({ message: 'the write would take the route table past its size limit' }),
  internal: (message: string) => new InternalServerError({ message }),
};

/** The 403 for a record that is missing or belongs to another application (§3.4 step 3). */
export const NOT_THIS_APPLICATION = 'the control plane holds no record of this application for the id';
