// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The teardown (spec §6.2, ordered teardown step 6): a custom resource on
 * the distribution, run by the CDK provider framework before the
 * distribution's delete. On Delete it removes what the registrar made
 * outside CloudFormation, because CloudFront cannot delete a distribution
 * that still has distribution tenants and a pending certificate has no
 * distribution tenant and would outlive the stack:
 *
 * 1. every dedicated distribution tenant on the distribution, tagged with
 *    it by the registrar: disabled when enabled, deleted once disabled and
 *    deployed;
 * 2. then every certificate the registrar tagged with the distribution,
 *    pending ones included.
 *
 * `onEvent` starts nothing. `isComplete` makes one pass of those steps per
 * poll and reports complete once nothing is left, so the provider polls
 * until each disable has deployed. Create and Update are complete at once.
 * It exists whether `dedicatedDomains` is on or off, so a front door that
 * once served a dedicated domain still tears down.
 */

import { ACMClient, DeleteCertificateCommand } from '@aws-sdk/client-acm';
import {
  CloudFrontClient,
  DeleteDistributionTenantCommand,
  GetDistributionTenantCommand,
  UpdateDistributionTenantCommand,
} from '@aws-sdk/client-cloudfront';
import { CERTIFICATE_REGION, distributionTenantTags, errorName, listDistributionTenants, listRegistrarCertificates } from './dedicated-resources';
import { TAG_DISTRIBUTION_ID } from '../shared/contracts';

/** The teardown's properties. */
export interface TeardownProperties {
  readonly DistributionId: string;
}

/** The provider framework's event: the CloudFormation request without the response URL. */
export interface TeardownEvent {
  readonly RequestType: 'Create' | 'Update' | 'Delete';
  readonly PhysicalResourceId?: string;
  readonly ResourceProperties: TeardownProperties & { readonly ServiceToken?: string };
}

export interface Deps {
  readonly cloudFront: Pick<CloudFrontClient, 'send'>;
  /** In `us-east-1`. */
  readonly acm: Pick<ACMClient, 'send'>;
}

/** A distribution tenant's status once its last change has reached every edge location. */
const DEPLOYED = 'Deployed';

/** Errors that mean the resource changed, went or is still in use: the next poll tries again. */
const RETRY_ERRORS = new Set([
  'PreconditionFailed',
  'InvalidIfMatchVersion',
  'ResourceInUseException',
  'ResourceNotDisabled',
  'EntityNotFound',
  'ResourceNotFoundException',
]);

/** One physical id per distribution, so a replaced distribution gets a Delete for the old one. */
export function physicalResourceId(distributionId: string): string {
  return `dedicated-domains-teardown-${distributionId}`;
}

export async function onEvent(event: TeardownEvent): Promise<{ PhysicalResourceId: string }> {
  const distributionId = event.ResourceProperties.DistributionId;
  if (typeof distributionId !== 'string' || distributionId === '') throw new Error('DistributionId is required');
  return { PhysicalResourceId: event.RequestType === 'Delete' && event.PhysicalResourceId !== undefined ? event.PhysicalResourceId : physicalResourceId(distributionId) };
}

export interface PassResult {
  /** Dedicated distribution tenants left after this pass. */
  readonly tenants: number;
  /** Registrar certificates left after this pass; not read while a distribution tenant is left. */
  readonly certificates?: number;
}

/**
 * One pass: disables or deletes each dedicated distribution tenant, and
 * once none is left deletes the registrar's certificates. Counts what is
 * left; a resource changed by another writer, or a certificate CloudFront
 * has not released yet, is left for the next poll.
 */
export async function teardownPass(distributionId: string, deps: Deps): Promise<PassResult> {
  let tenants = 0;
  for (const summary of await listDistributionTenants(deps.cloudFront, distributionId)) {
    let got;
    let tags;
    try {
      got = await deps.cloudFront.send(new GetDistributionTenantCommand({ Identifier: summary.Id }));
      if (got.DistributionTenant === undefined || got.DistributionTenant.DistributionId !== distributionId) continue;
      tags = await distributionTenantTags(deps.cloudFront, got.DistributionTenant.Arn);
    } catch (error) {
      if (RETRY_ERRORS.has(errorName(error))) continue;
      throw error;
    }
    const dt = got.DistributionTenant;
    // The pooled distribution tenant has no registrar tag; CloudFormation deletes it.
    if (!tags.some((t) => t.Key === TAG_DISTRIBUTION_ID && t.Value === distributionId)) continue;
    tenants++;
    try {
      if (dt.Enabled !== false) {
        await deps.cloudFront.send(new UpdateDistributionTenantCommand({
          Id: dt.Id,
          IfMatch: got.ETag,
          DistributionId: dt.DistributionId,
          Domains: dt.Domains?.map((d) => ({ Domain: d.Domain })),
          Customizations: dt.Customizations,
          Parameters: dt.Parameters,
          ConnectionGroupId: dt.ConnectionGroupId,
          Enabled: false,
        }));
        log('distribution tenant disabled', { distributionTenantId: dt.Id });
      } else if (dt.Status === DEPLOYED) {
        await deps.cloudFront.send(new DeleteDistributionTenantCommand({ Id: dt.Id, IfMatch: got.ETag }));
        tenants--;
        log('distribution tenant deleted', { distributionTenantId: dt.Id });
      }
    } catch (error) {
      if (!RETRY_ERRORS.has(errorName(error))) throw error;
    }
  }
  if (tenants > 0) return { tenants };

  let certificates = 0;
  for (const arn of await listRegistrarCertificates(deps.acm, distributionId)) {
    try {
      await deps.acm.send(new DeleteCertificateCommand({ CertificateArn: arn }));
      log('certificate deleted', { certificateArn: arn });
    } catch (error) {
      if (!RETRY_ERRORS.has(errorName(error))) throw error;
      if (errorName(error) !== 'ResourceNotFoundException') certificates++;
    }
  }
  return { tenants: 0, certificates };
}

export async function checkComplete(event: TeardownEvent, deps: Deps): Promise<{ IsComplete: boolean }> {
  if (event.RequestType !== 'Delete') return { IsComplete: true };
  const left = await teardownPass(event.ResourceProperties.DistributionId, deps);
  log('teardown pass', { tenantsLeft: left.tenants, certificatesLeft: left.certificates });
  return { IsComplete: left.tenants === 0 && left.certificates === 0 };
}

/** The provider framework's `isComplete` entry. */
export const isComplete = (event: TeardownEvent): Promise<{ IsComplete: boolean }> => checkComplete(event, defaultDeps());

function log(message: string, fields: Record<string, string | number | undefined>): void {
  process.stdout.write(`${JSON.stringify({ level: 'INFO', message, ...fields })}\n`);
}

let clients: Deps | undefined;
function defaultDeps(): Deps {
  clients ??= {
    cloudFront: new CloudFrontClient({ region: 'us-east-1' }),
    acm: new ACMClient({ region: CERTIFICATE_REGION }),
  };
  return clients;
}
