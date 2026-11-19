// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The SigV4 target of an `AWS_IAM` sink (spec §4.4). Only AWS endpoints
 * that verify SigV4 themselves are accepted: a signature sent to any other
 * host is a credential that host could replay for its lifetime.
 */

export interface IamTarget {
  readonly service: 'lambda' | 'execute-api';
  readonly region: string;
}

const LAMBDA_URL = /^[a-z0-9]{1,64}\.lambda-url\.([a-z]{2}(?:-[a-z]+)+-\d)\.on\.aws$/;
const EXECUTE_API = /^[a-z0-9]{10}\.execute-api\.([a-z]{2}(?:-[a-z]+)+-\d)\.amazonaws\.com$/;

/** The service and Region to sign for, or `undefined` for a host that is not a function URL or API Gateway endpoint. */
export function iamTarget(hostname: string): IamTarget | undefined {
  const lambda = LAMBDA_URL.exec(hostname);
  if (lambda !== null) {
    return { service: 'lambda', region: lambda[1] };
  }
  const api = EXECUTE_API.exec(hostname);
  if (api !== null) {
    return { service: 'execute-api', region: api[1] };
  }
  return undefined;
}
