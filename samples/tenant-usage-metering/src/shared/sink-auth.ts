// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The SigV4 target of an `AWS_IAM` sink (spec §4.4, ADR-0007). Only a
 * Lambda function URL or an API Gateway `execute-api` host is accepted, on
 * `https:` with no port and no credentials in the URL. The check keeps the
 * signing scope on an AWS endpoint that verifies SigV4 and lets the
 * dispatcher derive the service and Region. It does not decide who owns the
 * endpoint: what the dispatcher can actually invoke is set by the IAM grants
 * on its role (and, across accounts, the target's resource policy).
 *
 * `CreateSink`, `UpdateSink` and the dispatcher call the same function, so a
 * stored sink is never signed under looser rules than it was created with.
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

/** The SigV4 target of a whole `AWS_IAM` sink endpoint, or `undefined` when the URL may not be signed. */
export function iamSinkTarget(endpoint: string): IamTarget | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') {
    return undefined;
  }
  return iamTarget(url.hostname);
}
