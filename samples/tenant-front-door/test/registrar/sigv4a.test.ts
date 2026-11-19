// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CloudFrontKeyValueStoreClient, DescribeKeyValueStoreCommand } from '@aws-sdk/client-cloudfront-keyvaluestore';
import type { HttpRequest } from '@smithy/types';
// The registrar's store module: importing it must register the JS SigV4A signer.
import '../../src/registrar/route-store';

// Not imported from ./support, which mocks every KeyValueStore client.
const ROUTE_TABLE_ARN = 'arn:aws:cloudfront::123456789012:key-value-store/11111111-2222-3333-4444-555555555555';

describe('the KeyValueStore client signs with SigV4A (no CRT)', () => {
  test('@aws-sdk/signature-v4a resolves', () => {
    expect(() => require.resolve('@aws-sdk/signature-v4a')).not.toThrow();
  });

  test('a request from a client built like the function\'s carries an ECDSA (SigV4A) signature, with no network call', async () => {
    let captured: HttpRequest | undefined;
    const requestHandler = {
      handle: async (request: HttpRequest) => {
        captured = request;
        throw new Error('stop before the network');
      },
    };
    const client = new CloudFrontKeyValueStoreClient({
      region: 'eu-central-1',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
      requestHandler: requestHandler as never,
      maxAttempts: 1,
    });
    await expect(client.send(new DescribeKeyValueStoreCommand({ KvsARN: ROUTE_TABLE_ARN }))).rejects.toThrow('stop before the network');
    expect(captured).toBeDefined();
    expect(captured!.headers.authorization).toMatch(/^AWS4-ECDSA-P256-SHA256 /);
    expect(captured!.headers['x-amz-region-set']).toBe('*');
    expect(captured!.hostname).toBe('123456789012.cloudfront-kvs.global.api.aws');
  });
});
