// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The second phase of the two-phase removal (spec §3.4 step 5, ADR-0018),
 * every 15 minutes. The registrar's write removes `host#<d>`, `d`, `dk` and
 * `dx` at once and disables the domain's distribution tenant; this job
 * lists this distribution's distribution tenants and the registrar's
 * certificates and:
 *
 * - disables a dedicated distribution tenant whose domain is no longer the
 *   `d` of the tenant it is tagged with, if it is still enabled; deletes it
 *   once it is disabled and deployed; and deletes its certificate after it;
 * - deletes a registrar certificate that no distribution tenant uses and
 *   whose domain is no longer the `d` of the tenant it is tagged with (the
 *   domain was dropped or changed while the certificate was pending), or
 *   that is in a terminal status, whatever the tenant's `d`;
 * - logs a disabled distribution tenant whose domain is still routed for
 *   its tenant, which a removal racing the registrar's re-enable can leave.
 *
 * Before it touches a distribution tenant or a certificate it checks that
 * the resource's tags name this distribution and a tenant, so it never
 * touches the pooled distribution tenant, another distribution's resources
 * or a certificate the registrar did not request. A resource whose tenant
 * entry cannot be read is kept. It finds what a crashed registrar call left
 * the same way. It never writes the route table.
 */

import {
  type ACMClient,
  DeleteCertificateCommand,
  DescribeCertificateCommand,
  KeyAlgorithm,
  ListCertificatesCommand,
  ListTagsForCertificateCommand,
} from '@aws-sdk/client-acm';
import {
  type CloudFrontClient,
  DeleteDistributionTenantCommand,
  type DistributionTenant,
  type DistributionTenantSummary,
  GetDistributionTenantCommand,
  ListDistributionTenantsCommand,
  ListTagsForResourceCommand,
  UpdateDistributionTenantCommand,
} from '@aws-sdk/client-cloudfront';
import {
  type CloudFrontKeyValueStoreClient,
  GetKeyCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-cloudfront-keyvaluestore';
import { errorName, logLine } from './log';
import { TAG_DISTRIBUTION_ID, TAG_TENANT_ID, TERMINAL_CERTIFICATE_STATUSES } from '../shared/contracts';
import { decodeHostEntry, decodeTenantEntry, hostKey, tenantKey, toStoredId } from '../shared/route-table';

export interface RemovalDeps {
  readonly cloudFront: Pick<CloudFrontClient, 'send'>;
  /** ACM in `us-east-1`, where the registrar requests every certificate. */
  readonly acm: Pick<ACMClient, 'send'>;
  readonly kvs: Pick<CloudFrontKeyValueStoreClient, 'send'>;
  readonly routeTableArn: string;
  readonly distributionId: string;
}

export interface RemovalResult {
  readonly disabled: number;
  readonly deletedTenants: number;
  readonly deletedCertificates: number;
  /** Disabled distribution tenants whose domain is still routed for their tenant: logged for the operator. */
  readonly disabledRouted: number;
  readonly failures: number;
}

/** A distribution tenant's status once its last change has reached every edge location. */
const DEPLOYED = 'Deployed';

/** Errors that mean another writer changed the resource first or still uses it: the next run tries again. */
const RACE_ERRORS = new Set(['PreconditionFailed', 'InvalidIfMatchVersion', 'ResourceInUseException', 'ResourceNotDisabled', 'EntityNotFound', 'ResourceNotFoundException']);

/** The tenant a registrar resource names, or undefined when its tags are not this distribution's. */
function taggedTenant(tags: readonly { Key?: string; Value?: string }[] | undefined, distributionId: string): string | undefined {
  const get = (k: string): string | undefined => tags?.find((t) => t.Key === k)?.Value;
  if (get(TAG_DISTRIBUTION_ID) !== distributionId) return undefined;
  const tenant = get(TAG_TENANT_ID);
  if (tenant === undefined) return undefined;
  try {
    return toStoredId(tenant) === tenant ? tenant : undefined;
  } catch {
    return undefined;
  }
}

type Current = { readonly kind: 'domain'; readonly d: string | undefined } | { readonly kind: 'unreadable' };

export async function runRemoval(deps: RemovalDeps): Promise<RemovalResult> {
  const counts = { disabled: 0, deletedTenants: 0, deletedCertificates: 0, disabledRouted: 0, failures: 0 };

  /**
   * The tenant's current `d`; undefined when the entry or its `d` is gone.
   * Read again before every destructive call, never cached for the run, so
   * a domain the registrar set again since an earlier read is not removed.
   */
  const currentDomain = async (tenantId: string): Promise<Current> => {
    try {
      const value = (await deps.kvs.send(new GetKeyCommand({ KvsARN: deps.routeTableArn, Key: tenantKey(tenantId) }))).Value;
      return { kind: 'domain', d: value === undefined ? undefined : decodeTenantEntry(value).d };
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return { kind: 'domain', d: undefined };
      if (errorName(error) === 'RouteTableError') return { kind: 'unreadable' };
      throw error;
    }
  };

  /** True when the resource for `domains` tagged with `tenantId` is no longer wanted. */
  const isOrphan = async (tenantId: string, domains: readonly string[]): Promise<boolean> => {
    const current = await currentDomain(tenantId);
    if (current.kind === 'unreadable') {
      logLine('WARN', 'tenant entry unreadable; resource kept', { tenantId });
      return false;
    }
    return current.d === undefined || !domains.includes(current.d);
  };

  /** `host#<domain>` names the tenant. A value that does not decode names no one. */
  const isRouted = async (tenantId: string, domain: string): Promise<boolean> => {
    try {
      const value = (await deps.kvs.send(new GetKeyCommand({ KvsARN: deps.routeTableArn, Key: hostKey(domain) }))).Value;
      return value !== undefined && decodeHostEntry(value).t === tenantId;
    } catch (error) {
      if (error instanceof ResourceNotFoundException || errorName(error) === 'RouteTableError') return false;
      throw error;
    }
  };

  const attempt = async (resource: Record<string, string>, work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      const name = errorName(error);
      if (RACE_ERRORS.has(name)) {
        logLine('INFO', 'removal deferred', { ...resource, error: name });
      } else {
        counts.failures++;
        logLine('ERROR', 'removal failed', { ...resource, error: name });
      }
    }
  };

  /**
   * Deletes a registrar certificate that nothing uses: one in a terminal
   * status whatever its tenant's `d` (it can never serve), any other once
   * a fresh read shows its domain is no longer the tenant's `d`.
   */
  const deleteCertificate = async (arn: string, tenantId: string, domains: readonly string[]): Promise<void> => {
    const domain = domains.join(',');
    const certificate = (await deps.acm.send(new DescribeCertificateCommand({ CertificateArn: arn }))).Certificate;
    if ((certificate?.InUseBy?.length ?? 0) > 0) {
      logLine('INFO', 'certificate still in use', { tenantId, domain, certificateArn: arn });
      return;
    }
    const terminal = TERMINAL_CERTIFICATE_STATUSES.includes(certificate?.Status ?? '');
    if (!terminal && !(await isOrphan(tenantId, domains))) return;
    await deps.acm.send(new DeleteCertificateCommand({ CertificateArn: arn }));
    counts.deletedCertificates++;
    logLine('INFO', 'certificate deleted', { tenantId, domain, certificateArn: arn, status: terminal ? certificate?.Status : undefined });
  };

  // --- Distribution tenants -----------------------------------------------
  const summaries = await listDistributionTenants(deps);
  const certificatesOfTenants = new Set<string>();
  for (const s of summaries) {
    const arn = s.Customizations?.Certificate?.Arn;
    if (arn !== undefined) certificatesOfTenants.add(arn);
  }

  for (const summary of summaries) {
    await attempt({ distributionTenantId: summary.Id ?? '' }, async () => {
      const got = await deps.cloudFront.send(new GetDistributionTenantCommand({ Identifier: summary.Id }));
      const dt = got.DistributionTenant;
      if (dt === undefined || dt.DistributionId !== deps.distributionId) return;
      // Get and List return no tags; only ListTagsForResource does (design/spikes.md, Smoke run).
      if (dt.Arn === undefined) throw new Error('CloudFront returned a distribution tenant without an ARN');
      const dtTags = (await deps.cloudFront.send(new ListTagsForResourceCommand({ Resource: dt.Arn }))).Tags;
      const tenantId = taggedTenant(dtTags?.Items, deps.distributionId);
      if (tenantId === undefined) return;
      const domains = (dt.Domains ?? []).map((d) => d.Domain?.toLowerCase()).filter((d): d is string => d !== undefined);
      const domain = domains.join(',');

      // The fresh read of d comes right before the disable or the delete.
      if (!(await isOrphan(tenantId, domains))) {
        // Routed on a disabled distribution tenant: a removal raced the
        // registrar's re-enable. Nothing repairs it; the operator does (§3.4 step 5).
        if (dt.Enabled === false && (await Promise.all(domains.map((x) => isRouted(tenantId, x)))).some(Boolean)) {
          counts.disabledRouted++;
          logLine('WARN', 'distribution tenant disabled on a routed domain', { tenantId, domain, distributionTenantId: dt.Id });
        }
        return;
      }

      if (dt.Enabled !== false) {
        await deps.cloudFront.send(new UpdateDistributionTenantCommand(disableRequest(dt, got.ETag)));
        counts.disabled++;
        logLine('INFO', 'distribution tenant disabled', { tenantId, domain, distributionTenantId: dt.Id });
        return;
      }
      if (dt.Status !== DEPLOYED) return;

      await deps.cloudFront.send(new DeleteDistributionTenantCommand({ Id: dt.Id, IfMatch: got.ETag }));
      counts.deletedTenants++;
      logLine('INFO', 'distribution tenant deleted', { tenantId, domain, distributionTenantId: dt.Id });

      const arn = dt.Customizations?.Certificate?.Arn;
      if (arn === undefined) return;
      const tags = await deps.acm.send(new ListTagsForCertificateCommand({ CertificateArn: arn }));
      if (taggedTenant(tags.Tags, deps.distributionId) !== tenantId) return;
      // A certificate CloudFront has not released yet answers ResourceInUseException;
      // the certificate pass of a later run deletes it.
      await deleteCertificate(arn, tenantId, domains);
    });
  }

  // --- Certificates no distribution tenant uses ---------------------------
  for (const certificate of await listCertificates(deps)) {
    const arn = certificate.CertificateArn;
    const domain = certificate.DomainName?.toLowerCase();
    if (arn === undefined || domain === undefined || certificatesOfTenants.has(arn)) continue;
    await attempt({ certificateArn: arn }, async () => {
      const tags = await deps.acm.send(new ListTagsForCertificateCommand({ CertificateArn: arn }));
      const tenantId = taggedTenant(tags.Tags, deps.distributionId);
      if (tenantId === undefined) return;
      await deleteCertificate(arn, tenantId, [domain]);
    });
  }

  logLine(counts.failures > 0 ? 'ERROR' : 'INFO', 'removal', { ...counts });
  if (counts.failures > 0) throw new Error(`removal failed for ${counts.failures} resources`);
  return counts;
}

/** Disables the distribution tenant and sends back every other field as read, under the read's ETag. */
function disableRequest(dt: DistributionTenant, etag: string | undefined): UpdateDistributionTenantCommand['input'] {
  return {
    Id: dt.Id,
    IfMatch: etag,
    DistributionId: dt.DistributionId,
    Domains: dt.Domains?.map((d) => ({ Domain: d.Domain })),
    Customizations: dt.Customizations,
    Parameters: dt.Parameters,
    ConnectionGroupId: dt.ConnectionGroupId,
    Enabled: false,
  };
}

async function listDistributionTenants(deps: RemovalDeps): Promise<DistributionTenantSummary[]> {
  const out: DistributionTenantSummary[] = [];
  let marker: string | undefined;
  do {
    const page = await deps.cloudFront.send(new ListDistributionTenantsCommand({
      AssociationFilter: { DistributionId: deps.distributionId },
      Marker: marker,
    }));
    out.push(...(page.DistributionTenantList ?? []));
    marker = page.NextMarker;
  } while (marker !== undefined && marker !== '');
  return out;
}

async function listCertificates(deps: RemovalDeps): Promise<{ CertificateArn?: string; DomainName?: string }[]> {
  const out: { CertificateArn?: string; DomainName?: string }[] = [];
  let nextToken: string | undefined;
  do {
    // ListCertificates returns only RSA_2048 certificates unless keyTypes names the others.
    const page = await deps.acm.send(new ListCertificatesCommand({
      Includes: { keyTypes: Object.values(KeyAlgorithm) },
      NextToken: nextToken,
    }));
    out.push(...(page.CertificateSummaryList ?? []));
    nextToken = page.NextToken;
  } while (nextToken !== undefined);
  return out;
}
