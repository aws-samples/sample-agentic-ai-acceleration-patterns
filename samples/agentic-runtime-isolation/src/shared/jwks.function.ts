// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The JWKS custom resource (spec §5.2, C-13; ADR-0037). At deploy it reads
 * the public half of each signing key with KMS `GetPublicKey` and renders
 * the JWKS (`{ keys: [{ kty, kid, use: "sig", alg, n, e }] }`, or `x`/`y`
 * for P-256), current key first. The construct serves the result from a mock
 * integration, so no request ever reaches a Lambda or KMS (spec §5.2). The
 * key ids it returns are identifiers, never key material; the function
 * holds `kms:GetPublicKey` only.
 */

import { KMSClient } from '@aws-sdk/client-kms';
import { type CustomResourceEventBase, type CustomResourceOutcome, respond } from './cfn-response';
import { kmsPublicKey, publicJwk } from './jws';
import { errorName, log } from './logger';

export interface JwksEvent extends CustomResourceEventBase {
  readonly RequestType: 'Create' | 'Update' | 'Delete';
  readonly PhysicalResourceId?: string;
  readonly ResourceProperties: { readonly KeyIds: string[]; readonly ServiceToken?: string };
}

/** The JWKS document for these keys, current first. */
export async function renderJwks(kms: KMSClient, keyIds: readonly string[]): Promise<string> {
  const keys = [];
  for (const id of keyIds) {
    const { key, keyId } = await kmsPublicKey(kms, id);
    keys.push(publicJwk(key, keyId));
  }
  return JSON.stringify({ keys });
}

export async function handleEvent(event: JwksEvent, kms: KMSClient): Promise<CustomResourceOutcome> {
  const physicalResourceId = event.PhysicalResourceId ?? 'jwks';
  if (event.RequestType === 'Delete') {
    return { status: 'SUCCESS', physicalResourceId };
  }
  const keyIds = event.ResourceProperties.KeyIds;
  if (!Array.isArray(keyIds) || keyIds.length === 0 || keyIds.length > 2) {
    return { status: 'FAILED', physicalResourceId, reason: 'KeyIds must name one or two keys' };
  }
  try {
    return { status: 'SUCCESS', physicalResourceId, data: { Jwks: await renderJwks(kms, keyIds) } };
  } catch (error) {
    log.error('jwks render failed', { error: errorName(error) });
    return { status: 'FAILED', physicalResourceId, reason: `GetPublicKey failed: ${errorName(error)}` };
  }
}

const kms = new KMSClient({});

export const handler = async (event: JwksEvent): Promise<void> => {
  let outcome: CustomResourceOutcome;
  try {
    outcome = await handleEvent(event, kms);
  } catch (error) {
    outcome = { status: 'FAILED', physicalResourceId: event.PhysicalResourceId ?? 'jwks', reason: errorName(error) };
  }
  await respond(event, outcome);
};
