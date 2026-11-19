// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The reads the guard and the teardown share (spec §3.4 step 5, §6.2): the
 * distribution tenants on this distribution and the certificates the
 * registrar tagged with it. ACM is read in `us-east-1`, where the registrar
 * requests every certificate.
 */

import { type ACMClient, KeyAlgorithm, ListCertificatesCommand, ListTagsForCertificateCommand } from '@aws-sdk/client-acm';
import { type CloudFrontClient, type DistributionTenantSummary, ListDistributionTenantsCommand } from '@aws-sdk/client-cloudfront';
import { TAG_DISTRIBUTION_ID } from '../shared/contracts';

/** The Region of every registrar certificate: CloudFront takes certificates from `us-east-1` only. */
export const CERTIFICATE_REGION = 'us-east-1';

/** `ListTagsForCertificate` calls in flight at once, so an account with thousands of certificates reads in seconds. */
export const TAG_READS_AT_ONCE = 10;

export interface ReadOptions {
  readonly abortSignal?: AbortSignal;
}

/** Every distribution tenant on the distribution, pooled one included. */
export async function listDistributionTenants(
  cloudFront: Pick<CloudFrontClient, 'send'>,
  distributionId: string,
  options: ReadOptions = {},
): Promise<DistributionTenantSummary[]> {
  const out: DistributionTenantSummary[] = [];
  let marker: string | undefined;
  do {
    const page = await cloudFront.send(new ListDistributionTenantsCommand({
      AssociationFilter: { DistributionId: distributionId },
      Marker: marker,
    }), options);
    out.push(...(page.DistributionTenantList ?? []));
    marker = page.NextMarker;
  } while (marker !== undefined && marker !== '');
  return out;
}

/**
 * The ARNs of the certificates tagged with this distribution: the
 * registrar's, pending ones included. `stopAtFirst` ends the read at the
 * first one found, for a caller that needs only to know one exists.
 */
export async function listRegistrarCertificates(
  acm: Pick<ACMClient, 'send'>,
  distributionId: string,
  options: ReadOptions & { readonly stopAtFirst?: boolean } = {},
): Promise<string[]> {
  const found: string[] = [];
  let nextToken: string | undefined;
  do {
    // ListCertificates returns only RSA_2048 certificates unless keyTypes names the others.
    const page = await acm.send(new ListCertificatesCommand({
      Includes: { keyTypes: Object.values(KeyAlgorithm) },
      NextToken: nextToken,
    }), options);
    const arns = (page.CertificateSummaryList ?? []).map((c) => c.CertificateArn).filter((a): a is string => a !== undefined);
    for (let i = 0; i < arns.length; i += TAG_READS_AT_ONCE) {
      const batch = arns.slice(i, i + TAG_READS_AT_ONCE);
      const tagged = await Promise.all(batch.map(async (arn) => {
        let tags;
        try {
          tags = (await acm.send(new ListTagsForCertificateCommand({ CertificateArn: arn }), options)).Tags;
        } catch (error) {
          // Deleted between the list and the tag read: gone, so not held.
          if (errorName(error) === 'ResourceNotFoundException') return undefined;
          throw error;
        }
        return tags?.some((t) => t.Key === TAG_DISTRIBUTION_ID && t.Value === distributionId) === true ? arn : undefined;
      }));
      found.push(...tagged.filter((a): a is string => a !== undefined));
      if (options.stopAtFirst === true && found.length > 0) return found;
    }
    nextToken = page.NextToken;
  } while (nextToken !== undefined);
  return found;
}

/** An error's name only: its message could quote a value. */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
