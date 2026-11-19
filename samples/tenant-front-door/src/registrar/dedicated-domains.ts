// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { createHash, randomBytes } from 'node:crypto';
import {
  type ACMClient,
  type CertificateDetail,
  DescribeCertificateCommand,
  LimitExceededException,
  ListCertificatesCommand,
  ListTagsForCertificateCommand,
  RequestCertificateCommand,
  type Tag as AcmTag,
} from '@aws-sdk/client-acm';
import {
  CNAMEAlreadyExists,
  type CloudFrontClient,
  CreateDistributionTenantCommand,
  type DistributionTenant,
  EntityNotFound,
  GetDistributionTenantByDomainCommand,
  ListTagsForResourceCommand,
  type Tags as CloudFrontTags,
  UpdateDistributionTenantCommand,
} from '@aws-sdk/client-cloudfront';
import { refuse } from './errors';
import { logLine } from './log';
import type { ReadKey, RouteStore } from './route-store';
import { CHALLENGE_TTL_SECONDS, TAG_COST_TENANT_ID, TAG_DISTRIBUTION_ID, TAG_TENANT_ID, TERMINAL_CERTIFICATE_STATUSES } from '../shared/contracts';
import { type ChallengeOutcome, challengeRecordName, challengeRecordValue, checkChallenge, type DnsLookup } from '../shared/dns-challenge';
import { decodeHostEntry, encodeEntry, hostEntry, hostKey, RouteTableError, type TenantEntry, tenantEntry, tenantKey } from '../shared/route-table';
import type { DnsRecord, PutTenantRouteServerOutput } from '../smithy/source/typescript-ssdk-codegen/src';

/**
 * The seam for dedicated domains (spec §3.4 step 5 sub-steps 1 to 6,
 * ADR-0018): the domain challenge, the ACM certificate, the dedicated
 * distribution tenant and the `host#<d>` write.
 *
 * The registrar has already run every check that does not need ACM,
 * CloudFront or DNS when it calls `putTenantDomain`: the caller is the edge
 * operator role, `dedicatedDomains` is on, the domain is outside
 * `appDomain`, and `check` passed once (§3.4 steps 3 and 4). Every write
 * here runs `check` again on the store's fresh read, so an ETag conflict
 * repeats those checks before the next attempt (§3.4 step 5).
 */
export interface DomainCheck {
  /** The `tenant#` entry, matching the deployment's `accountId` and `createdAt`, with its cell route. */
  readonly entry: TenantEntry;
  /** `host#<customDomain>` exists and names this tenant. */
  readonly routed: boolean;
}

export interface DomainRequest {
  /** Stored (lower-case) tenant id. */
  readonly tenantId: string;
  /** The tenant id as the caller sent it, echoed in the answer. */
  readonly requestTenantId: string;
  readonly customDomain: string;
  /** What `check` returned on the registrar's own read. */
  readonly first: DomainCheck;
  /** The step 3 operator checks and the step 4 `host#` owner check; throws the refusal. */
  readonly check: (read: ReadKey) => Promise<DomainCheck>;
  readonly store: RouteStore;
}

export interface DedicatedDomains {
  /** The operator's `PutTenantRoute` with a `customDomain`: 200 once routed, 202 while pending. */
  putTenantDomain(request: DomainRequest): Promise<PutTenantRouteServerOutput>;

  /**
   * Called after a write removed a tenant's `d` and its `host#<d>` (a
   * dropped or changed domain, a deleted or replaced tenant route, a
   * cleared `host#` key): disables the domain's distribution tenant, after
   * checking its tags name this tenant and this distribution. The sweeper
   * deletes it and its certificate later (two-phase removal).
   */
  releaseDomain(tenantId: string, domain: string): Promise<void>;
}

/** While `dedicatedDomains` is off: the registrar refuses `customDomain` with 400 before it gets here. */
export class DedicatedDomainsOff implements DedicatedDomains {
  async putTenantDomain(): Promise<PutTenantRouteServerOutput> {
    throw refuse.internal('dedicated domains are off');
  }

  async releaseDomain(): Promise<void> {
    // Nothing to disable: no distribution tenant is created while the switch is off.
  }
}

/** CloudFront serves a distribution tenant's certificate from `us-east-1` only (§3.4 step 5 sub-step 3). */
export const CERTIFICATE_REGION = 'us-east-1';

/** Rounds of the sub-steps when a write finds the entry changed by another writer; then 503. */
export const MAX_ROUNDS = 5;

/**
 * The distribution tenant's name: `tfd-` and 32 hex characters of a
 * SHA-256 over the distribution, the tenant and the domain, 36 characters,
 * inside CloudFront's 128 for any tenant id and domain (§3.4 step 5).
 */
export function distributionTenantName(distributionId: string, tenantId: string, domain: string): string {
  return `tfd-${createHash('sha256').update(`${distributionId}\n${tenantId}\n${domain}`).digest('hex').slice(0, 32)}`;
}

/** `DescribeCertificate` reads while ACM has not yet attached a new certificate's validation record. */
export const RECORD_READS = 5;
export const RECORD_READ_GAP_MS = 1_000;

export interface AwsDedicatedDomainsOptions {
  /** An ACM client in `us-east-1`. */
  readonly acm: ACMClient;
  readonly cloudfront: CloudFrontClient;
  /** The multi-tenant distribution the dedicated distribution tenants attach to. */
  readonly distributionId: string;
  readonly lookup: DnsLookup;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** 43 base64url characters; tests replace it. */
  readonly newToken?: () => string;
}

/** 32 bytes from a cryptographic random source, base64url without padding (§3.4 step 5 sub-step 1). */
export function newChallengeToken(): string {
  return randomBytes(32).toString('base64url');
}

interface OwnCertificate {
  readonly arn: string;
}

/** A write planned on the re-read entry, and the entry it leaves. */
interface Planned {
  readonly entry: TenantEntry;
  readonly puts: Readonly<Record<string, string>>;
  readonly deletes?: readonly string[];
  /** A domain this write removed, for the distribution tenant's release after it. */
  readonly release?: string;
}

/** What a write's plan found: the entry was as the decision assumed, or another writer changed it. */
type WriteResult =
  | { readonly written: true; readonly entry: TenantEntry; readonly release?: string }
  | { readonly written: false; readonly reread: DomainCheck };

/** One round's end: an answer, or the re-read state to start the sub-steps again from. */
type Round = { readonly answer: PutTenantRouteServerOutput } | { readonly reread: DomainCheck };

function sameChallenge(a: TenantEntry, b: TenantEntry): boolean {
  return a.d === b.d && a.dk === b.dk && a.dx === b.dx;
}

function withDomain(e: TenantEntry, d: string | undefined, dk: string | undefined, dx: number | undefined): TenantEntry {
  return tenantEntry({ c: e.c, ac: e.ac, dt: e.dt, s: e.s, n: e.n, d, dk, dx });
}

/** A `host#` value that does not decode names no one, so it is kept. */
function hostNames(value: string, tenantId: string): boolean {
  try {
    return decodeHostEntry(value).t === tenantId;
  } catch (error) {
    if (error instanceof RouteTableError) return false;
    throw error;
  }
}

function cloudFrontTag(tags: CloudFrontTags | undefined, key: string): string | undefined {
  return tags?.Items?.find((t) => t.Key === key)?.Value;
}

/** The tags on a dedicated domain's certificate and distribution tenant (§3.4 step 5). */
function registrarTags(tenantId: string, distributionId: string): { Key: string; Value: string }[] {
  return [
    { Key: TAG_TENANT_ID, Value: tenantId },
    { Key: TAG_DISTRIBUTION_ID, Value: distributionId },
    { Key: TAG_COST_TENANT_ID, Value: tenantId.toUpperCase() },
  ];
}

function acmTag(tags: AcmTag[] | undefined, key: string): string | undefined {
  return tags?.find((t) => t.Key === key)?.Value;
}

/**
 * The ACM, CloudFront and DNS side of a dedicated domain. Every call is
 * repeat-safe: it finds what an earlier call made and creates only what is
 * missing (§3.4 step 5).
 */
export class AwsDedicatedDomains implements DedicatedDomains {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly newToken: () => string;

  constructor(private readonly options: AwsDedicatedDomainsOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.newToken = options.newToken ?? newChallengeToken;
  }

  async putTenantDomain(request: DomainRequest): Promise<PutTenantRouteServerOutput> {
    let state = request.first;
    // Once host#<d> exists, a repeat looks nothing up and answers 200 (sub-step 5).
    if (this.isRouted(request, state)) return this.routed(request, state.entry);
    // §3.4 step 4: a registrar certificate for the domain tagged for another tenant is that tenant's pending claim.
    const own = await this.ownCertificates(request.tenantId, request.customDomain);
    // Tokens whose challenge passed in this invocation: sub-step 5 does not resolve them again.
    const passedNow = new Set<string>();
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const next = await this.round(request, state, own, passedNow);
      if ('answer' in next) return next.answer;
      state = next.reread;
    }
    throw refuse.unavailable('the tenant route keeps changing; retry');
  }

  /**
   * Best effort: it runs after the route table write has landed, so a
   * failure is logged by its error name and never changes the answer. The
   * sweeper disables an enabled distribution tenant whose domain is no
   * longer its tenant's `d` (§3.4 step 5).
   */
  async releaseDomain(tenantId: string, domain: string): Promise<void> {
    try {
      await this.disable(tenantId, domain);
    } catch (error) {
      logLine('WARN', 'distribution tenant release failed; the sweeper disables it', {
        tenantId,
        domain,
        error: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }

  private async disable(tenantId: string, domain: string): Promise<void> {
    const found = await this.distributionTenant(domain);
    if (found === undefined) return;
    await this.requireOwnDistributionTenant(found.tenant, tenantId);
    if (found.tenant.Enabled === false) return;
    await this.updateDistributionTenant(found.tenant, found.etag, { enabled: false });
  }

  // -------------------------------------------------------------------------
  // The sub-steps
  // -------------------------------------------------------------------------

  private isRouted(request: DomainRequest, state: DomainCheck): boolean {
    return state.routed && state.entry.d === request.customDomain;
  }

  private async round(request: DomainRequest, state: DomainCheck, own: OwnCertificate[], passedNow: Set<string>): Promise<Round> {
    const d = request.customDomain;
    let entry = state.entry;
    if (this.isRouted(request, state)) return { answer: this.routed(request, entry) };

    // Sub-step 1: a new domain, written first with a new challenge.
    if (entry.d !== d || entry.dk === undefined) return this.issueChallenge(request, entry);

    // Sub-step 2: the challenge is open.
    if (entry.dx !== undefined) {
      if (entry.dx <= Math.floor(this.now() / 1000)) return this.issueChallenge(request, entry);
      const outcome = await this.resolve(d, entry.dk);
      if (outcome !== 'pass') return { answer: this.pending(request, entry, 'domain-challenge', this.challengeRecord(d, entry.dk), outcome) };
      const passed = await this.write(request, entry, async (e) => {
        const next = withDomain(e, d, e.dk, undefined);
        return { entry: next, puts: { [tenantKey(request.tenantId)]: encodeEntry(next) } };
      });
      if (!passed.written) return { reread: passed.reread };
      entry = passed.entry;
      passedNow.add(entry.dk!);
    }

    // Sub-step 3: the challenge has passed; find the certificate or request it.
    const dk = entry.dk!;
    let certificate = await this.certificate(own);
    if (certificate === undefined) {
      const arn = await this.requestCertificate(request.tenantId, d, dk);
      own.push({ arn });
      certificate = await this.describeWithRecord(arn, d);
    }

    // Sub-steps 4 and 6.
    if (certificate.Status === 'PENDING_VALIDATION') {
      return { answer: this.pending(request, entry, 'certificate', this.validationRecord(certificate, d)) };
    }
    if (certificate.Status !== 'ISSUED') throw refuse.unprocessable(this.failureMessage(certificate));

    // Sub-step 5: the certificate issued; the challenge is checked once
    // more, unless it passed seconds ago in this invocation.
    if (!passedNow.has(dk)) {
      const outcome = await this.resolve(d, dk);
      if (outcome !== 'pass') return { answer: this.pending(request, entry, 'challenge-recheck', this.challengeRecord(d, dk), outcome) };
    }
    await this.ensureDistributionTenant(request.tenantId, d, certificate.CertificateArn!);
    const routed = await this.write(request, entry, async (e) => ({
      entry: e,
      puts: { [hostKey(d)]: encodeEntry(hostEntry({ t: request.tenantId, ac: e.ac })) },
    }));
    if (!routed.written) return { reread: routed.reread };
    return { answer: this.routed(request, routed.entry) };
  }

  /** Sub-step 1, and an expired challenge in sub-step 2: a new token and expiry; looks nothing up. */
  private async issueChallenge(request: DomainRequest, based: TenantEntry): Promise<Round> {
    const d = request.customDomain;
    const dk = this.newToken();
    const dx = Math.floor(this.now() / 1000) + CHALLENGE_TTL_SECONDS;
    const result = await this.write(request, based, async (e, read) => {
      const deletes: string[] = [];
      let release: string | undefined;
      // A changed domain goes as a drop would: d, dk, dx and its host#<d> in this write (§3.4 step 5).
      if (e.d !== undefined && e.d !== d) {
        release = e.d;
        const holder = await read(hostKey(e.d));
        if (holder !== undefined && hostNames(holder, request.tenantId)) deletes.push(hostKey(e.d));
      }
      const next = withDomain(e, d, dk, dx);
      return { entry: next, puts: { [tenantKey(request.tenantId)]: encodeEntry(next) }, deletes, release };
    });
    if (!result.written) return { reread: result.reread };
    if (result.release !== undefined) await this.releaseDomain(request.tenantId, result.release);
    return { answer: this.pending(request, result.entry, 'domain-challenge', this.challengeRecord(d, dk)) };
  }

  /**
   * One write with the store's ETag, planned on a fresh read: `check`
   * runs again, and the write goes ahead only while the entry still holds
   * the `d`, `dk` and `dx` the decision rested on and `host#<d>` is not yet
   * this tenant's. Otherwise nothing is written and the sub-steps start
   * again from the re-read state (§3.4 step 5, last paragraphs).
   */
  private async write(
    request: DomainRequest,
    based: TenantEntry,
    plan: (entry: TenantEntry, read: ReadKey) => Promise<Planned>,
  ): Promise<WriteResult> {
    return request.store.update<WriteResult>(async (read) => {
      const state = await request.check(read);
      if (!sameChallenge(state.entry, based) || this.isRouted(request, state)) {
        const result: WriteResult = { written: false, reread: state };
        return { result };
      }
      const planned = await plan(state.entry, read);
      const result: WriteResult = { written: true, entry: planned.entry, release: planned.release };
      return { puts: planned.puts, deletes: planned.deletes, result };
    });
  }

  private resolve(domain: string, token: string): Promise<ChallengeOutcome> {
    return checkChallenge(domain, token, { lookup: this.options.lookup, sleep: this.sleep });
  }

  // -------------------------------------------------------------------------
  // Answers
  // -------------------------------------------------------------------------

  private routed(request: DomainRequest, entry: TenantEntry): PutTenantRouteServerOutput {
    return { statusCode: 200, tenantId: request.requestTenantId, dt: entry.dt };
  }

  private pending(
    request: DomainRequest,
    entry: TenantEntry,
    stage: 'domain-challenge' | 'certificate' | 'challenge-recheck',
    record: DnsRecord | undefined,
    challenge?: Exclude<ChallengeOutcome, 'pass'>,
  ): PutTenantRouteServerOutput {
    return { statusCode: 202, tenantId: request.requestTenantId, dt: entry.dt, stage, record, challenge };
  }

  private challengeRecord(domain: string, token: string): DnsRecord {
    return { name: challengeRecordName(domain), type: 'TXT', value: challengeRecordValue(token) };
  }

  private validationRecord(certificate: CertificateDetail, domain: string): DnsRecord | undefined {
    const record = certificate.DomainValidationOptions?.find((o) => o.DomainName === domain)?.ResourceRecord;
    if (record?.Name === undefined || record.Value === undefined) return undefined;
    return { name: record.Name, type: 'CNAME', value: record.Value };
  }

  /** ACM's failure reason is one of its own enum values; it names no tenant. */
  private failureMessage(certificate: CertificateDetail): string {
    if (certificate.Status === 'FAILED') return `the certificate failed validation: ${certificate.FailureReason ?? 'OTHER'}`;
    if (certificate.Status === 'VALIDATION_TIMED_OUT') return 'the certificate validation timed out';
    return `the certificate is ${certificate.Status ?? 'in an unknown status'}`;
  }

  // -------------------------------------------------------------------------
  // ACM (us-east-1)
  // -------------------------------------------------------------------------

  /**
   * The registrar's certificates for the domain, found by domain name and
   * tags. A certificate that carries either tag and does not name this
   * tenant and this distribution is another claim: 409, naming no tenant
   * (§3.4 step 4). Certificates without the tags are not the registrar's.
   */
  private async ownCertificates(tenantId: string, domain: string): Promise<OwnCertificate[]> {
    const { acm, distributionId } = this.options;
    const own: OwnCertificate[] = [];
    let token: string | undefined;
    do {
      const page = await acm.send(new ListCertificatesCommand({ NextToken: token }));
      for (const summary of page.CertificateSummaryList ?? []) {
        if (summary.DomainName !== domain || summary.CertificateArn === undefined) continue;
        const tags = (await acm.send(new ListTagsForCertificateCommand({ CertificateArn: summary.CertificateArn }))).Tags;
        const tenant = acmTag(tags, TAG_TENANT_ID);
        const distribution = acmTag(tags, TAG_DISTRIBUTION_ID);
        if (tenant === undefined && distribution === undefined) continue;
        if (tenant !== tenantId || distribution !== distributionId) throw refuse.conflict('customDomain is held pending by another tenant');
        own.push({ arn: summary.CertificateArn });
      }
      token = page.NextToken;
    } while (token !== undefined);
    return own;
  }

  /**
   * The certificate the domain uses: an issued one, else a pending one.
   * One in a terminal status counts as absent, so sub-step 3 requests a
   * new one (sub-step 6).
   */
  private async certificate(own: readonly OwnCertificate[]): Promise<CertificateDetail | undefined> {
    const details: CertificateDetail[] = [];
    for (const c of own) {
      const detail = (await this.options.acm.send(new DescribeCertificateCommand({ CertificateArn: c.arn }))).Certificate;
      if (detail !== undefined) details.push(detail);
    }
    return details.find((x) => x.Status === 'ISSUED')
      ?? details.find((x) => x.Status === 'PENDING_VALIDATION')
      ?? details.find((x) => !TERMINAL_CERTIFICATE_STATUSES.includes(x.Status ?? ''));
  }

  /**
   * Requests the certificate with DNS validation and the registrar's tags. The
   * idempotency token is derived from the distribution, the tenant, the
   * domain and the challenge token, so a repeat within ACM's hour gets the
   * same certificate.
   */
  private async requestCertificate(tenantId: string, domain: string, dk: string): Promise<string> {
    const { acm, distributionId } = this.options;
    const idempotency = createHash('sha256').update(`${distributionId}\n${tenantId}\n${domain}\n${dk}`).digest('hex').slice(0, 32);
    try {
      const out = await acm.send(new RequestCertificateCommand({
        DomainName: domain,
        ValidationMethod: 'DNS',
        IdempotencyToken: idempotency,
        Tags: registrarTags(tenantId, distributionId),
      }));
      if (out.CertificateArn === undefined) throw refuse.internal('ACM returned no certificate ARN');
      return out.CertificateArn;
    } catch (error) {
      if (error instanceof LimitExceededException) throw refuse.certificateQuota();
      throw error;
    }
  }

  /**
   * ACM attaches a new certificate's validation record a few seconds
   * after the request; read it until it is there, then answer without it.
   */
  private async describeWithRecord(arn: string, domain: string): Promise<CertificateDetail> {
    let detail: CertificateDetail | undefined;
    for (let i = 0; i < RECORD_READS; i++) {
      if (i > 0) await this.sleep(RECORD_READ_GAP_MS);
      detail = (await this.options.acm.send(new DescribeCertificateCommand({ CertificateArn: arn }))).Certificate;
      if (detail?.Status !== 'PENDING_VALIDATION' || this.validationRecord(detail, domain) !== undefined) break;
    }
    if (detail === undefined) throw refuse.internal('ACM returned no certificate');
    return detail;
  }

  // -------------------------------------------------------------------------
  // CloudFront
  // -------------------------------------------------------------------------

  private async distributionTenant(domain: string): Promise<{ tenant: DistributionTenant; etag: string | undefined } | undefined> {
    try {
      const out = await this.options.cloudfront.send(new GetDistributionTenantByDomainCommand({ Domain: domain }));
      return out.DistributionTenant === undefined ? undefined : { tenant: out.DistributionTenant, etag: out.ETag };
    } catch (error) {
      if (error instanceof EntityNotFound) return undefined;
      throw error;
    }
  }

  /**
   * A distribution tenant on another distribution, or not tagged with this
   * tenant and distribution, is someone else's: 409. `Get` and `List`
   * responses carry no tags, so they are read with `ListTagsForResource`
   * (design/spikes.md, Smoke run).
   */
  private async requireOwnDistributionTenant(tenant: DistributionTenant, tenantId: string): Promise<void> {
    const { distributionId } = this.options;
    const other = (): Error => refuse.conflict('customDomain is served by a distribution tenant of another tenant');
    if (tenant.DistributionId !== distributionId) throw other();
    if (tenant.Arn === undefined) throw refuse.internal('CloudFront returned a distribution tenant without an ARN');
    const tags = (await this.options.cloudfront.send(new ListTagsForResourceCommand({ Resource: tenant.Arn }))).Tags;
    if (cloudFrontTag(tags, TAG_TENANT_ID) !== tenantId || cloudFrontTag(tags, TAG_DISTRIBUTION_ID) !== distributionId) throw other();
  }

  /**
   * Creates the distribution tenant with the certificate and the registrar's tags,
   * unless it exists. One that exists for this tenant but is disabled (the
   * domain was dropped and set again before the sweeper deleted it) or
   * holds another certificate is updated to serve with this one.
   */
  private async ensureDistributionTenant(tenantId: string, domain: string, certificateArn: string): Promise<void> {
    const { cloudfront, distributionId } = this.options;
    const found = await this.distributionTenant(domain);
    if (found !== undefined) {
      await this.requireOwnDistributionTenant(found.tenant, tenantId);
      if (found.tenant.Enabled !== false && found.tenant.Customizations?.Certificate?.Arn === certificateArn) return;
      await this.updateDistributionTenant(found.tenant, found.etag, { enabled: true, certificateArn });
      return;
    }
    try {
      await cloudfront.send(new CreateDistributionTenantCommand({
        DistributionId: distributionId,
        Name: distributionTenantName(distributionId, tenantId, domain),
        Domains: [{ Domain: domain }],
        Customizations: { Certificate: { Arn: certificateArn } },
        Tags: { Items: registrarTags(tenantId, distributionId) },
        Enabled: true,
      }));
    } catch (error) {
      // Another distribution tenant already serves the domain, here or in another account (§3.4 step 5).
      if (error instanceof CNAMEAlreadyExists) throw refuse.conflict('customDomain is already served by CloudFront');
      throw error;
    }
  }

  /** Writes back what the tenant holds, changing only `Enabled` and, when given, the certificate. */
  private async updateDistributionTenant(
    tenant: DistributionTenant,
    etag: string | undefined,
    change: { enabled: boolean; certificateArn?: string },
  ): Promise<void> {
    const customizations = change.certificateArn === undefined
      ? tenant.Customizations
      : { ...tenant.Customizations, Certificate: { Arn: change.certificateArn } };
    await this.options.cloudfront.send(new UpdateDistributionTenantCommand({
      Id: tenant.Id,
      DistributionId: tenant.DistributionId,
      IfMatch: etag,
      Domains: tenant.Domains?.map((x) => ({ Domain: x.Domain })),
      Customizations: customizations,
      Parameters: tenant.Parameters,
      ConnectionGroupId: tenant.ConnectionGroupId,
      Enabled: change.enabled,
    }));
  }
}
