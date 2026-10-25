// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Domain errors. The registry and the provisioners throw these; the service
 * layers (platform, tenant users) map them to the Smithy errors of spec §5.3.
 * Messages are safe to return to the caller: they never carry a token, a
 * password, or Cognito's own message.
 */

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** The operation has no meaning in this topology (spec P-4). */
export class UnsupportedInTopologyError extends Error {
  constructor(operation: string, topology: string) {
    super(`${operation} is not supported in topology ${topology}`);
    this.name = 'UnsupportedInTopologyError';
  }
}

/** Input that passed the model's constraints but is still invalid. */
export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInputError';
  }
}
