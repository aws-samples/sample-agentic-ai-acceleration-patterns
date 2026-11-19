// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * SigV4 signing of an `AWS_IAM` sink delivery (spec §4.4), as the
 * dispatcher's own role. The caller has already checked the host
 * (src/shared/sink-auth.ts).
 */

import { Sha256 } from '@aws-crypto/sha256-js';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@smithy/types';
import type { RequestSigner } from './dispatcher';

/** A signer for the given identity; the Lambda entry uses the function's own role. */
export const sigV4Signer = (identity: AwsCredentialIdentity | AwsCredentialIdentityProvider): RequestSigner => async (url, init, target) => {
  const parsed = new URL(url);
  const query: Record<string, string> = {};
  parsed.searchParams.forEach((value, key) => {
    query[key] = value;
  });
  const request = new HttpRequest({
    method: init.method,
    protocol: 'https:',
    hostname: parsed.hostname,
    path: parsed.pathname,
    query,
    headers: { ...init.headers, host: parsed.hostname },
    body: init.body,
  });
  const signer = new SignatureV4({ service: target.service, region: target.region, credentials: identity, sha256: Sha256 });
  const signed = await signer.sign(request);
  return signed.headers as Record<string, string>;
};

export const sigV4Sign: RequestSigner = sigV4Signer(fromNodeProviderChain());
