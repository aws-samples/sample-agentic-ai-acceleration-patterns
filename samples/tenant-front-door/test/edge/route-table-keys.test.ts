// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  CloudFrontKeyValueStoreClient,
  ConflictException,
  DescribeKeyValueStoreCommand,
  GetKeyCommand,
  ResourceNotFoundException,
  UpdateKeysCommand,
} from '@aws-sdk/client-cloudfront-keyvaluestore';
import { mockClient } from 'aws-sdk-client-mock';
import {
  answerWithin,
  Deps,
  handleEvent,
  MAX_ATTEMPTS,
  nextSigninEntry,
  RouteTableKeysEvent,
  RouteTableKeysProperties,
} from '../../src/custom-resources/route-table-keys.function';
import { decodeSigninEntry, encodeEntry, signinEntry } from '../../src/shared/route-table';

const KVS = 'arn:aws:cloudfront::111111111111:key-value-store/00000000-0000-0000-0000-000000000000';
const APP = '{"v":1,"az":"https://a.example.com/oauth2/authorize","tk":"https://a.example.com/oauth2/token","cid":"c","sc":"openid","lo":"https://a.example.com/logout"}';

const kvs = mockClient(CloudFrontKeyValueStoreClient);
let keyCounter = 0;
const deps: Deps = {
  client: new CloudFrontKeyValueStoreClient({ region: 'us-east-1' }),
  newKey: () => Buffer.alloc(32, ++keyCounter).toString('base64'),
  sleep: async () => undefined,
};

function event(props: Partial<RouteTableKeysProperties>, requestType: RouteTableKeysEvent['RequestType'] = 'Update'): RouteTableKeysEvent {
  return {
    RequestType: requestType,
    PhysicalResourceId: 'route-table-keys',
    ResponseURL: 'https://cloudformation-response.example.com/x',
    StackId: 'stack',
    RequestId: 'request',
    LogicalResourceId: 'RouteTableKeys',
    ResourceProperties: { KeyValueStoreArn: KVS, App: APP, ...props },
  };
}

function storedSignin(value: string | undefined): void {
  if (value === undefined) {
    kvs.on(GetKeyCommand).rejects(new ResourceNotFoundException({ message: 'not found', $metadata: {} }));
  } else {
    kvs.on(GetKeyCommand).resolves({ Key: 'signin', Value: value });
  }
}

function update(): Record<string, any> {
  const calls = kvs.commandCalls(UpdateKeysCommand);
  expect(calls).toHaveLength(1);
  return calls[0].args[0].input;
}

beforeEach(() => {
  kvs.reset();
  keyCounter = 0;
  kvs.on(DescribeKeyValueStoreCommand).resolves({ ETag: 'etag-1' });
  kvs.on(UpdateKeysCommand).resolves({ ETag: 'etag-2' });
});

describe('route table keys custom resource (spec §4.1, ADR-0016, M-20)', () => {
  it('writes app under the store ETag in single mode, and no signin', async () => {
    storedSignin(undefined);
    expect(await handleEvent(event({}, 'Create'), deps)).toEqual({ status: 'SUCCESS', physicalResourceId: 'route-table-keys' });
    expect(update()).toEqual({ KvsARN: KVS, IfMatch: 'etag-1', Puts: [{ Key: 'app', Value: APP }], Deletes: undefined });
  });

  it('removes a signin key a former host mode left, in single mode', async () => {
    storedSignin(encodeEntry(signinEntry({ cur: 'k1', k: { k1: 'a2V5' } })));
    await handleEvent(event({}), deps);
    expect(update().Deletes).toEqual([{ Key: 'signin' }]);
  });

  it('makes a 32-byte key for each id in host mode on create', async () => {
    storedSignin(undefined);
    await handleEvent(event({ SigninIds: ['k1'], SigninCurrent: 'k1' }, 'Create'), deps);
    const put = update().Puts.find((p: any) => p.Key === 'signin');
    const entry = decodeSigninEntry(put.Value);
    expect(entry.cur).toBe('k1');
    expect(Buffer.from(entry.k.k1, 'base64')).toHaveLength(32);
  });

  it('rotates by the §4.1 rules: keeps listed keys, makes new ones, drops unlisted, sets cur', async () => {
    const old = Buffer.alloc(32, 200).toString('base64');
    const dropped = Buffer.alloc(32, 201).toString('base64');
    storedSignin(encodeEntry(signinEntry({ cur: 'k1', k: { k1: old, k0: dropped } })));
    await handleEvent(event({ SigninIds: ['k1', 'k2'], SigninCurrent: 'k2' }), deps);
    const entry = decodeSigninEntry(update().Puts.find((p: any) => p.Key === 'signin').Value);
    expect(entry.cur).toBe('k2');
    expect(Object.keys(entry.k).sort()).toEqual(['k1', 'k2']);
    expect(entry.k.k1).toBe(old);
    expect(entry.k.k2).not.toBe(old);
  });

  it('replaces an unreadable stored signin entry with fresh keys', async () => {
    storedSignin('not json');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await handleEvent(event({ SigninIds: ['k1'], SigninCurrent: 'k1' }), deps);
    expect(decodeSigninEntry(update().Puts[1].Value).k.k1).toBe(Buffer.alloc(32, 1).toString('base64'));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('not json');
    warn.mockRestore();
  });

  it('re-reads and retries on an ETag conflict, and fails after five attempts (M-15)', async () => {
    storedSignin(undefined);
    kvs.on(UpdateKeysCommand)
      .rejectsOnce(new ConflictException({ message: 'etag', $metadata: {} }))
      .resolves({ ETag: 'etag-3' });
    expect((await handleEvent(event({}), deps)).status).toBe('SUCCESS');
    expect(kvs.commandCalls(DescribeKeyValueStoreCommand)).toHaveLength(2);

    kvs.on(UpdateKeysCommand).rejects(new ConflictException({ message: 'etag', $metadata: {} }));
    kvs.resetHistory();
    const outcome = await handleEvent(event({}), deps);
    expect(outcome).toMatchObject({ status: 'FAILED', reason: 'route table write failed: ConflictException' });
    expect(kvs.commandCalls(UpdateKeysCommand)).toHaveLength(MAX_ATTEMPTS);
  });

  it('reads the data plane\'s stale-ETag answer, a ValidationException that says the pre-condition failed, as a conflict', async () => {
    storedSignin(undefined);
    kvs.on(UpdateKeysCommand)
      .rejectsOnce(Object.assign(new Error('Pre-Condition failed'), { name: 'ValidationException' }))
      .resolves({ ETag: 'etag-3' });
    kvs.resetHistory();
    expect((await handleEvent(event({}), deps)).status).toBe('SUCCESS');
    expect(kvs.commandCalls(UpdateKeysCommand)).toHaveLength(2);
  });

  it('reports a failure by error name only, never a key or a message', async () => {
    storedSignin(undefined);
    kvs.on(UpdateKeysCommand).rejects(Object.assign(new Error(`bad value ${APP}`), { name: 'ValidationException' }));
    const outcome = await handleEvent(event({ SigninIds: ['k1'], SigninCurrent: 'k1' }), deps);
    expect(outcome.reason).toBe('route table write failed: ValidationException');
    expect(JSON.stringify(outcome)).not.toContain(Buffer.alloc(32, 1).toString('base64'));
  });

  it('refuses a SigninCurrent outside SigninIds', async () => {
    expect(await handleEvent(event({ SigninIds: ['k1'], SigninCurrent: 'k2' }), deps)).toMatchObject({ status: 'FAILED' });
    expect(kvs.calls()).toHaveLength(0);
  });

  it('does nothing on Delete: the store goes with the stack', async () => {
    expect(await handleEvent(event({}, 'Delete'), deps)).toEqual({ status: 'SUCCESS', physicalResourceId: 'route-table-keys' });
    expect(kvs.calls()).toHaveLength(0);
  });

  it('answers FAILED with Timeout before the function times out when a call never settles', async () => {
    let seen: AbortSignal | undefined;
    const never = (signal: AbortSignal) => {
      seen = signal;
      return new Promise<never>(() => undefined);
    };
    expect(await answerWithin(never, 10, 'route-table-keys')).toEqual({ status: 'FAILED', physicalResourceId: 'route-table-keys', reason: 'Timeout' });
    expect(seen?.aborted).toBe(true);
    const done = async () => ({ status: 'SUCCESS' as const, physicalResourceId: 'route-table-keys' });
    expect(await answerWithin(done, 10_000, 'route-table-keys')).toEqual({ status: 'SUCCESS', physicalResourceId: 'route-table-keys' });
  });

  it('writes nothing more once the deadline has aborted it, so a rollback is not overwritten (M-15)', async () => {
    storedSignin(undefined);
    kvs.on(UpdateKeysCommand).rejects(new ConflictException({ message: 'etag', $metadata: {} }));
    const controller = new AbortController();
    const aborting: Deps = { ...deps, sleep: async () => controller.abort(), signal: controller.signal };
    expect(await handleEvent(event({}), aborting)).toMatchObject({ status: 'FAILED', reason: 'Timeout' });
    expect(kvs.commandCalls(UpdateKeysCommand)).toHaveLength(1);
  });

  it('does not write when the deadline fires between the reads and UpdateKeys', async () => {
    const controller = new AbortController();
    kvs.on(GetKeyCommand).callsFake(() => {
      controller.abort();
      throw new ResourceNotFoundException({ message: 'not found', $metadata: {} });
    });
    expect(await handleEvent(event({}), { ...deps, signal: controller.signal })).toMatchObject({ status: 'FAILED', reason: 'Timeout' });
    expect(kvs.commandCalls(UpdateKeysCommand)).toHaveLength(0);
  });

  it('nextSigninEntry keeps the order of SigninIds', () => {
    const e = nextSigninEntry(undefined, ['b2', 'a1'], 'a1', () => 'a2V5');
    expect(encodeEntry(e)).toBe('{"v":1,"cur":"a1","k":{"b2":"a2V5","a1":"a2V5"}}');
  });
});
