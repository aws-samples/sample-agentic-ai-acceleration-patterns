// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { EventEmitter } from 'node:events';
import type * as https from 'node:https';
import { respond } from '../../src/custom-resources/cfn-response';

const event = {
  ResponseURL: 'https://cloudformation-response.example.com/path?sig=abc',
  StackId: 'stack',
  RequestId: 'request',
  LogicalResourceId: 'RouteTableKeys',
};

/** A stand-in for `https.request` that records the options and the body. */
function fakeRequest(fail = false) {
  const sent: { options?: https.RequestOptions; body?: string } = {};
  const request = ((options: https.RequestOptions, onResponse: (res: EventEmitter & { resume(): void }) => void) => {
    sent.options = options;
    const req = new EventEmitter() as EventEmitter & { end(body: string): void };
    req.end = (body: string) => {
      sent.body = body;
      if (fail) {
        req.emit('error', new Error('network'));
        return;
      }
      const res = Object.assign(new EventEmitter(), { resume: () => undefined });
      onResponse(res);
      res.emit('end');
    };
    return req;
  }) as unknown as typeof https.request;
  return { request, sent };
}

describe('custom resource answer (M-20)', () => {
  it('PUTs the outcome to the pre-signed URL with no Data, so nothing the handler holds reaches the response', async () => {
    const { request, sent } = fakeRequest();
    await respond(event, { status: 'SUCCESS', physicalResourceId: 'route-table-keys' }, request);
    expect(sent.options).toMatchObject({ hostname: 'cloudformation-response.example.com', path: '/path?sig=abc', method: 'PUT' });
    expect(JSON.parse(sent.body!)).toEqual({
      Status: 'SUCCESS',
      Reason: 'See the sample README',
      PhysicalResourceId: 'route-table-keys',
      StackId: 'stack',
      RequestId: 'request',
      LogicalResourceId: 'RouteTableKeys',
    });
  });

  it('never throws when the PUT fails: a thrown answer would stall the stack for an hour', async () => {
    const { request } = fakeRequest(true);
    await expect(respond(event, { status: 'FAILED', physicalResourceId: 'x', reason: 'r' }, request)).resolves.toBeUndefined();
  });
});
