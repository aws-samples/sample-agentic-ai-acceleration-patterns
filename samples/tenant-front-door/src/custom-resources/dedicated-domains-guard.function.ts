// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The guard (spec §3.4, "While `dedicatedDomains` is off"): a custom
 * resource that exists in both states of `dedicatedDomains` and takes it as
 * its `DedicatedDomains` property, so CloudFormation sends it an Update when
 * the switch flips. It refuses only the on-to-off Update, and only while
 *
 * - a `tenant#` entry of the route table holds a `d`, or
 * - the distribution has a distribution tenant other than the pooled one
 *   (only the registrar creates the others, §3.1), or
 * - a certificate is tagged with this distribution (the registrar's).
 *
 * The stack updates the registrar function first, so new `customDomain`
 * writes get 400, and the guard depends on it. Before it reads, the guard
 * waits `REGISTRAR_DRAIN_MS`: the 10 s Lambda init limit plus the
 * registrar's 30 s timeout, so every call that started on the old
 * configuration has ended. A refusal rolls the whole update back. Create,
 * Delete, an off-to-on Update and any other Update succeed at once.
 */

import { ACMClient } from '@aws-sdk/client-acm';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { CloudFrontKeyValueStoreClient, ListKeysCommand } from '@aws-sdk/client-cloudfront-keyvaluestore';
// The KeyValueStore data plane signs with SigV4A; importing the pure-JS
// signer registers it with the SDK's multi-Region signer.
import '@aws-sdk/signature-v4a';
import { CustomResourceEventBase, CustomResourceOutcome, respond } from './cfn-response';
import { CERTIFICATE_REGION, errorName, listDistributionTenants, listRegistrarCertificates } from './dedicated-resources';
import { ANSWER_MARGIN_MS, answerWithin } from './route-table-keys.function';
import { decodeTenantEntry } from '../shared/route-table';

export const PHYSICAL_RESOURCE_ID = 'dedicated-domains-guard';

/** The 10 s Lambda init limit plus the registrar function's 30 s timeout (§3.4). */
export const REGISTRAR_DRAIN_MS = 40_000;

/** ListKeys' page limit. */
const LIST_KEYS_MAX = 50;

const TENANT_PREFIX = 'tenant#';

/** The guard's properties. CloudFormation passes every value as a string. */
export interface GuardProperties {
  /** `on` or `off`. */
  readonly DedicatedDomains: string;
  readonly KeyValueStoreArn: string;
  readonly DistributionId: string;
  readonly PooledTenantId: string;
}

export interface GuardEvent extends CustomResourceEventBase {
  readonly RequestType: 'Create' | 'Update' | 'Delete';
  readonly PhysicalResourceId?: string;
  readonly ResourceProperties: GuardProperties & { readonly ServiceToken?: string };
  readonly OldResourceProperties?: Partial<GuardProperties>;
}

export interface Deps {
  readonly kvs: Pick<CloudFrontKeyValueStoreClient, 'send'>;
  readonly cloudFront: Pick<CloudFrontClient, 'send'>;
  /** In `us-east-1`. */
  readonly acm: Pick<ACMClient, 'send'>;
  readonly sleep: (ms: number) => Promise<void>;
  /** Aborted when the answer has gone out without this run. */
  readonly signal?: AbortSignal;
}

export async function handleEvent(event: GuardEvent, deps: Deps): Promise<CustomResourceOutcome> {
  const physicalResourceId = event.PhysicalResourceId ?? PHYSICAL_RESOURCE_ID;
  const ok: CustomResourceOutcome = { status: 'SUCCESS', physicalResourceId };
  if (event.RequestType !== 'Update') return ok;
  if (event.OldResourceProperties?.DedicatedDomains !== 'on' || event.ResourceProperties.DedicatedDomains !== 'off') return ok;

  const p = event.ResourceProperties;
  const options = { abortSignal: deps.signal };
  const refuse = (what: string): CustomResourceOutcome => ({
    status: 'FAILED',
    physicalResourceId,
    reason: `dedicatedDomains cannot be turned off while ${what}: drop every customDomain and wait for the sweeper first (spec §3.4)`,
  });

  await deps.sleep(REGISTRAR_DRAIN_MS);
  try {
    const withDomain = await countTenantEntriesWithDomain(deps, p.KeyValueStoreArn, options);
    if (withDomain > 0) return refuse(`${withDomain} tenant route(s) hold a dedicated domain`);

    const tenants = (await listDistributionTenants(deps.cloudFront, p.DistributionId, options)).filter((t) => t.Id !== p.PooledTenantId);
    if (tenants.length > 0) return refuse(`${tenants.length} dedicated distribution tenant(s) remain`);

    const certificates = await listRegistrarCertificates(deps.acm, p.DistributionId, { ...options, stopAtFirst: true });
    if (certificates.length > 0) return refuse('a registrar certificate remains');
  } catch (error) {
    // A read that fails is no proof that nothing is left.
    return { status: 'FAILED', physicalResourceId, reason: `guard read failed: ${errorName(error)}` };
  }
  return ok;
}

/** `tenant#` entries with a `d`. An entry that cannot be decoded counts: the guard cannot show it holds none. */
async function countTenantEntriesWithDomain(deps: Deps, kvsArn: string, options: { abortSignal?: AbortSignal }): Promise<number> {
  let count = 0;
  let nextToken: string | undefined;
  do {
    const page = await deps.kvs.send(new ListKeysCommand({ KvsARN: kvsArn, MaxResults: LIST_KEYS_MAX, NextToken: nextToken }), options);
    for (const item of page.Items ?? []) {
      if (item.Key === undefined || !item.Key.startsWith(TENANT_PREFIX)) continue;
      try {
        if (item.Value === undefined || decodeTenantEntry(item.Value).d !== undefined) count++;
      } catch {
        count++;
      }
    }
    nextToken = page.NextToken;
  } while (nextToken !== undefined);
  return count;
}

const sdk = { requestHandler: { requestTimeout: 10_000 } };
const deps: Deps = {
  kvs: new CloudFrontKeyValueStoreClient(sdk),
  cloudFront: new CloudFrontClient({ ...sdk, region: 'us-east-1' }),
  acm: new ACMClient({ ...sdk, region: CERTIFICATE_REGION }),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export const handler = async (event: GuardEvent, context: { getRemainingTimeInMillis(): number }): Promise<void> => {
  const physicalResourceId = event.PhysicalResourceId ?? PHYSICAL_RESOURCE_ID;
  let outcome: CustomResourceOutcome;
  try {
    outcome = await answerWithin(
      (signal) => handleEvent(event, { ...deps, signal }),
      context.getRemainingTimeInMillis() - ANSWER_MARGIN_MS,
      physicalResourceId,
    );
  } catch (error) {
    outcome = { status: 'FAILED', physicalResourceId, reason: errorName(error) };
  }
  await respond(event, outcome);
};
