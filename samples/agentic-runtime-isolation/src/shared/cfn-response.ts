// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The CloudFormation custom-resource answer, shared by this sample's
 * handlers (registry entry, owner-marked rows, tool policy, JWKS). It PUTs
 * the outcome to the pre-signed `ResponseURL` and never throws: a lost
 * answer stalls the stack for an hour.
 */

import * as https from 'node:https';

export interface CustomResourceEventBase {
  readonly ResponseURL: string;
  readonly StackId: string;
  readonly RequestId: string;
  readonly LogicalResourceId: string;
}

export interface CustomResourceOutcome {
  readonly status: 'SUCCESS' | 'FAILED';
  readonly physicalResourceId: string;
  readonly reason?: string;
  /** Attributes for `Fn::GetAtt` (at most 4 KB in all). */
  readonly data?: Record<string, string>;
}

export function respond(
  event: CustomResourceEventBase,
  outcome: CustomResourceOutcome,
  request: typeof https.request = https.request,
): Promise<void> {
  const body = JSON.stringify({
    Status: outcome.status,
    Reason: outcome.reason ?? 'See the sample README',
    PhysicalResourceId: outcome.physicalResourceId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    ...(outcome.data !== undefined ? { Data: outcome.data } : {}),
  });
  const url = new URL(event.ResponseURL);
  return new Promise((resolve) => {
    const req = request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'PUT',
        headers: { 'content-type': '', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('error', () => resolve());
    req.end(body);
  });
}
