// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { CallerRole } from './caller';
import type { RegistrarConfig } from './config';
import type { ControlPlane, DeploymentRecord } from './control-plane';
import type { DedicatedDomains, DomainCheck } from './dedicated-domains';
import { NOT_THIS_APPLICATION, refuse } from './errors';
import type { ReadKey, RouteStore } from './route-store';
import {
  cellEntry,
  cellKey,
  decodeCellEntry,
  decodeHostEntry,
  decodeTenantEntry,
  encodeEntry,
  hostEntry,
  hostKey,
  isReservedLabel,
  RouteTableError,
  type RouteStatus,
  sanitiseDisplayName,
  type TenantEntry,
  tenantEntry,
  tenantKey,
  toStoredId,
} from '../shared/route-table';
import type {
  DeleteCellRouteServerInput,
  DeleteCellRouteServerOutput,
  DeleteHostRouteServerInput,
  DeleteHostRouteServerOutput,
  DeleteTenantRouteServerInput,
  DeleteTenantRouteServerOutput,
  PutCellRouteServerInput,
  PutCellRouteServerOutput,
  PutTenantRouteServerInput,
  PutTenantRouteServerOutput,
  RegistrarServiceService,
  UpdateTenantRouteStatusServerInput,
  UpdateTenantRouteStatusServerOutput,
} from '../smithy/source/typescript-ssdk-codegen/src';

/**
 * The route registrar (spec §3.4, §5.1): the only writer of the route
 * table. Admission (the resource policy, then `classifyCaller` in the
 * function) only gets a caller here; every write that sets placement is
 * checked against the control plane, never against the request
 * (ADR-0013, ADR-0015, ADR-0017). The edge operator role's deletes and
 * status changes set none and skip the read (ADR-0025).
 */

/** Built by the function per request from the signed request context. */
export interface RegistrarContext {
  readonly role: CallerRole;
  /** Filled in by the operation for the function's log line (§3.4 step 6). */
  key?: string;
  /** The class name of an unmodelled error, for the same log line. */
  error?: string;
}

export interface RegistrarDeps {
  readonly config: RegistrarConfig;
  readonly controlPlane: ControlPlane;
  readonly store: RouteStore;
  readonly domains: DedicatedDomains;
}

/** A control-plane status in which the hook's put runs (control-plane R-45). */
const PUT_STATUSES: readonly string[] = ['CREATING', 'UPDATING'];

/** The Region part of a Lambda function URL host; the model pins the rest of the form. */
const FUNCTION_URL_REGION = /^[a-z0-9]{32}\.lambda-url\.([a-z0-9-]+)\.on\.aws$/;

/**
 * `<tenantId>.<appDomain>` in `host` mode (§4.1), refusing a reserved label
 * with 400. A guard only: the model's `TenantId` is a 26-character ULID, so
 * no API call reaches a reserved label today.
 */
export function pooledHost(storedTenantId: string, appDomain: string): string {
  if (isReservedLabel(storedTenantId)) throw refuse.badRequest('the tenant id is a reserved host label');
  return `${storedTenantId}.${appDomain}`;
}

async function readTenant(read: ReadKey, storedId: string): Promise<TenantEntry | undefined> {
  const value = await read(tenantKey(storedId));
  return value === undefined ? undefined : decodeTenantEntry(value);
}

/**
 * The `tenant#` entry for a delete: an entry that does not decode is still
 * deleted, so the operator can clear a damaged key, and names no domain.
 */
async function readTenantForDelete(read: ReadKey, storedId: string): Promise<TenantEntry | undefined> {
  try {
    return await readTenant(read, storedId);
  } catch (error) {
    if (!(error instanceof RouteTableError)) throw error;
    return undefined;
  }
}

/** The `host#` owner, or undefined for a value that does not decode or names no valid tenant id. */
function hostOwner(value: string): string | undefined {
  try {
    return toStoredId(decodeHostEntry(value).t);
  } catch (error) {
    if (!(error instanceof RouteTableError)) throw error;
    return undefined;
  }
}

/** True when the `host#` key exists and its `t` names the tenant; a value that does not decode names no one, so it is kept. */
async function hostNamesTenant(read: ReadKey, host: string, storedId: string): Promise<boolean> {
  const value = await read(hostKey(host));
  return value !== undefined && hostOwner(value) === storedId;
}

export class RegistrarService implements RegistrarServiceService<RegistrarContext> {
  constructor(private readonly deps: RegistrarDeps) {}

  // -------------------------------------------------------------------------
  // Cell routes
  // -------------------------------------------------------------------------

  PutCellRoute = async (input: PutCellRouteServerInput, ctx: RegistrarContext): Promise<PutCellRouteServerOutput> => {
    const { config, controlPlane, store } = this.deps;
    const cellId = toStoredId(input.cellId!);
    const apiDomain = input.apiDomain!;
    ctx.key = cellKey(cellId);

    // §3.4 step 3: a function URL host in the control plane's Region.
    if (FUNCTION_URL_REGION.exec(apiDomain)?.[1] !== config.controlPlaneRegion) {
      throw refuse.badRequest('apiDomain is not a Lambda function URL host in the control plane Region');
    }
    // §3.4 step 2 and 3: the record, its application and, for the hook, its status.
    const cell = await controlPlane.getCell(cellId);
    if (cell === undefined || cell.applicationId !== config.applicationId) throw refuse.forbidden(NOT_THIS_APPLICATION);
    if (ctx.role === 'hook' && !PUT_STATUSES.includes(cell.status)) {
      throw refuse.conflict('the cell is neither CREATING nor UPDATING');
    }
    // §3.4 step 5: the account from the control plane; the origin is write-once for the hook.
    const value = encodeEntry(cellEntry({ ac: cell.accountId, o: apiDomain }));
    await store.update(async (read) => {
      const stored = await read(ctx.key!);
      if (ctx.role === 'hook' && stored !== undefined && decodeCellEntry(stored).o !== apiDomain) {
        throw refuse.conflict('the cell route holds another origin; only the edge operator role changes it');
      }
      return { puts: { [ctx.key!]: value }, result: undefined };
    });
    return { cellId: input.cellId!, apiDomain };
  };

  DeleteCellRoute = async (input: DeleteCellRouteServerInput, ctx: RegistrarContext): Promise<DeleteCellRouteServerOutput> => {
    const { config, controlPlane, store } = this.deps;
    const cellId = toStoredId(input.cellId!);
    ctx.key = cellKey(cellId);
    // The operator's deletes skip step 2, to clear a route a skipped hook left (§3.4).
    if (ctx.role === 'hook') {
      const cell = await controlPlane.getCell(cellId);
      if (cell !== undefined) {
        if (cell.applicationId !== config.applicationId) throw refuse.forbidden(NOT_THIS_APPLICATION);
        if (cell.status !== 'DELETING') throw refuse.conflict('the cell is neither missing nor DELETING');
      }
    }
    await store.update(async (read) => {
      await read(ctx.key!);
      return { deletes: [ctx.key!], result: undefined };
    });
    return {};
  };

  // -------------------------------------------------------------------------
  // Tenant routes
  // -------------------------------------------------------------------------

  PutTenantRoute = async (input: PutTenantRouteServerInput, ctx: RegistrarContext): Promise<PutTenantRouteServerOutput> => {
    const tenantId = toStoredId(input.tenantId!);
    ctx.key = tenantKey(tenantId);
    if (input.customDomain !== undefined) {
      // §3.4 step 3: only the operator sets a domain, and only while dedicatedDomains is on.
      if (ctx.role !== 'operator') throw refuse.forbidden('only the edge operator role may send customDomain');
      if (!this.deps.config.dedicatedDomains) throw refuse.badRequest('customDomain needs dedicatedDomains on');
    }
    if (ctx.role === 'hook') return this.hookPutTenantRoute(input.tenantId!, tenantId);
    return this.operatorPutTenantRoute(input.tenantId!, tenantId, input.customDomain);
  };

  /** The route hook's put on deployment create and update (§3.4 steps 2 to 5). */
  private async hookPutTenantRoute(requestTenantId: string, tenantId: string): Promise<PutTenantRouteServerOutput> {
    const { config, controlPlane, store } = this.deps;
    const host = config.addressing === 'host' ? pooledHost(tenantId, config.appDomain) : undefined;
    // Both reads at once, inside API Gateway's 29 s; the deployment's answer is judged first.
    const [deploymentRead, tenantRead] = await Promise.allSettled([this.deployment(tenantId), controlPlane.getTenant(tenantId)]);
    if (deploymentRead.status === 'rejected') throw deploymentRead.reason;
    const deployment = deploymentRead.value;
    if (!PUT_STATUSES.includes(deployment.status)) throw refuse.conflict('the deployment is neither CREATING nor UPDATING');
    if (tenantRead.status === 'rejected') throw tenantRead.reason;
    const tenant = tenantRead.value;
    if (tenant === undefined) throw refuse.forbidden(NOT_THIS_APPLICATION);
    const cellId = toStoredId(deployment.cellId);
    const n = sanitiseDisplayName(tenant.name);

    const released = await store.update(async (read) => {
      // §3.4 step 4: the cell route exists, with the deployment's account.
      await this.requireCellRoute(read, cellId, deployment.accountId);
      const old = await readTenant(read, tenantId);
      const puts: Record<string, string> = {};
      const deletes: string[] = [];
      let release: string | undefined;
      let entry: TenantEntry;
      if (old === undefined) {
        entry = tenantEntry({ c: cellId, ac: deployment.accountId, dt: deployment.dt, s: 'active', n });
      } else if (old.dt === deployment.dt) {
        // A retry or an update of this deployment: keeps s and the domain with its challenge.
        entry = tenantEntry({ c: cellId, ac: deployment.accountId, dt: deployment.dt, s: old.s, n, d: old.d, dk: old.dk, dx: old.dx });
      } else {
        // An entry an earlier deployment left (§3.4 step 5): replaced, keeping only s.
        entry = tenantEntry({ c: cellId, ac: deployment.accountId, dt: deployment.dt, s: old.s, n });
        if (old.d !== undefined) {
          release = old.d;
          if (await hostNamesTenant(read, old.d, tenantId)) deletes.push(hostKey(old.d));
        }
      }
      puts[tenantKey(tenantId)] = encodeEntry(entry);
      if (host !== undefined) {
        await read(hostKey(host));
        puts[hostKey(host)] = encodeEntry(hostEntry({ t: tenantId, ac: deployment.accountId }));
      }
      return { puts, deletes, result: release };
    });
    if (released !== undefined) await this.deps.domains.releaseDomain(tenantId, released);
    return { statusCode: 200, tenantId: requestTenantId, dt: deployment.dt };
  }

  /**
   * The operator's put changes only the domain of an existing tenant route
   * (§3.4 step 3): the entry must exist and match the deployment's account
   * and `createdAt`, and keeps its `c`, `ac`, `dt`, `s` and `n`. With no
   * `customDomain` it drops the stored domain.
   */
  private async operatorPutTenantRoute(
    requestTenantId: string,
    tenantId: string,
    customDomain: string | undefined,
  ): Promise<PutTenantRouteServerOutput> {
    const { config, store, domains } = this.deps;
    if (customDomain !== undefined && (customDomain === config.appDomain || customDomain.endsWith(`.${config.appDomain}`))) {
      throw refuse.badRequest('customDomain is appDomain or a name under it');
    }
    const deployment = await this.deployment(tenantId);

    if (customDomain !== undefined) {
      // Steps 3 and 4 on one read; the seam runs them again on every write it makes.
      const check = async (read: ReadKey): Promise<DomainCheck> => {
        const entry = await this.requireOperatorEntry(read, tenantId, deployment);
        const holder = await read(hostKey(customDomain));
        if (holder !== undefined && decodeHostEntry(holder).t !== tenantId) {
          throw refuse.conflict('customDomain is held by another tenant');
        }
        return { entry, routed: holder !== undefined };
      };
      const first = await store.update(async (read) => ({ result: await check(read) }));
      return domains.putTenantDomain({ tenantId, requestTenantId, customDomain, first, check, store });
    }

    const result = await store.update(async (read) => {
      const entry = await this.requireOperatorEntry(read, tenantId, deployment);
      if (entry.d === undefined) return { result: { entry, release: undefined as string | undefined } };
      const deletes = (await hostNamesTenant(read, entry.d, tenantId)) ? [hostKey(entry.d)] : [];
      const kept = tenantEntry({ c: entry.c, ac: entry.ac, dt: entry.dt, s: entry.s, n: entry.n });
      return { puts: { [tenantKey(tenantId)]: encodeEntry(kept) }, deletes, result: { entry: kept, release: entry.d } };
    });
    if (result.release !== undefined) await domains.releaseDomain(tenantId, result.release);
    return { statusCode: 200, tenantId: requestTenantId, dt: result.entry.dt };
  }

  /** §3.4 steps 3 and 4 for the operator's put: the entry, the deployment it was written for, and its cell route. */
  private async requireOperatorEntry(read: ReadKey, tenantId: string, deployment: DeploymentRecord): Promise<TenantEntry> {
    const entry = await readTenant(read, tenantId);
    if (entry === undefined) throw refuse.conflict('the tenant has no route');
    if (entry.ac !== deployment.accountId || entry.dt !== deployment.dt) {
      throw refuse.conflict('the tenant route was written for another deployment');
    }
    await this.requireCellRoute(read, entry.c, entry.ac);
    return entry;
  }

  DeleteTenantRoute = async (input: DeleteTenantRouteServerInput, ctx: RegistrarContext): Promise<DeleteTenantRouteServerOutput> => {
    const { config, controlPlane, store, domains } = this.deps;
    const tenantId = toStoredId(input.tenantId!);
    ctx.key = tenantKey(tenantId);
    if (ctx.role === 'hook') {
      const deployment = await controlPlane.getDeployment(tenantId, config.applicationId);
      if (deployment !== undefined) {
        if (deployment.applicationId !== config.applicationId) throw refuse.forbidden(NOT_THIS_APPLICATION);
        if (deployment.status !== 'DELETING') throw refuse.conflict('the deployment is neither missing nor DELETING');
      }
    }
    const release = await store.update(async (read) => {
      const entry = await readTenantForDelete(read, tenantId);
      const deletes = [tenantKey(tenantId)];
      // Each host# key goes only when its t names this tenant (§5.1).
      if (config.addressing === 'host') {
        const host = `${tenantId}.${config.appDomain}`;
        if (await hostNamesTenant(read, host, tenantId)) deletes.push(hostKey(host));
      }
      if (entry?.d !== undefined && (await hostNamesTenant(read, entry.d, tenantId))) deletes.push(hostKey(entry.d));
      return { deletes, result: entry?.d };
    });
    if (release !== undefined) await domains.releaseDomain(tenantId, release);
    return {};
  };

  UpdateTenantRouteStatus = async (
    input: UpdateTenantRouteStatusServerInput,
    ctx: RegistrarContext,
  ): Promise<UpdateTenantRouteStatusServerOutput> => {
    const tenantId = toStoredId(input.tenantId!);
    ctx.key = tenantKey(tenantId);
    if (ctx.role !== 'operator') throw refuse.forbidden('only the edge operator role changes a route status');
    const status = input.status as RouteStatus;
    // The status writes no placement value, so it is not checked against the
    // control plane: a suspension still works while the control plane is down
    // (§3.4, ADR-0025).
    await this.deps.store.update(async (read) => {
      const entry = await readTenant(read, tenantId);
      if (entry === undefined) throw refuse.conflict('the tenant has no route');
      const next = tenantEntry({ c: entry.c, ac: entry.ac, dt: entry.dt, s: status, n: entry.n, d: entry.d, dk: entry.dk, dx: entry.dx });
      return { puts: { [tenantKey(tenantId)]: encodeEntry(next) }, result: undefined };
    });
    return { tenantId: input.tenantId!, status: input.status! };
  };

  // -------------------------------------------------------------------------
  // Host routes
  // -------------------------------------------------------------------------

  DeleteHostRoute = async (input: DeleteHostRouteServerInput, ctx: RegistrarContext): Promise<DeleteHostRouteServerOutput> => {
    const { store, domains } = this.deps;
    const host = input.host!;
    ctx.key = hostKey(host);
    if (ctx.role !== 'operator') throw refuse.forbidden('only the edge operator role clears a host route');
    const release = await store.update(async (read) => {
      const value = await read(hostKey(host));
      if (value === undefined) return { result: undefined as { tenantId: string; domain: string } | undefined };
      // A key whatever its t and ac (§5.1): one that does not decode is deleted and touches no d.
      const owner = hostOwner(value);
      const entry = owner === undefined ? undefined : await readTenantForDelete(read, owner);
      if (owner === undefined || entry?.d !== host) return { deletes: [hostKey(host)], result: undefined };
      // The host is that tenant's dedicated domain: d goes with it (§5.1).
      const kept = tenantEntry({ c: entry.c, ac: entry.ac, dt: entry.dt, s: entry.s, n: entry.n });
      return { puts: { [tenantKey(owner)]: encodeEntry(kept) }, deletes: [hostKey(host)], result: { tenantId: owner, domain: host } };
    });
    if (release !== undefined) await domains.releaseDomain(release.tenantId, release.domain);
    return {};
  };

  // -------------------------------------------------------------------------
  // Shared checks
  // -------------------------------------------------------------------------

  /** `GetDeployment` for this front door's application: 403 when missing or another application's (§3.4 step 3). */
  private async deployment(tenantId: string): Promise<DeploymentRecord> {
    const { config, controlPlane } = this.deps;
    const deployment = await controlPlane.getDeployment(tenantId, config.applicationId);
    if (deployment === undefined || deployment.applicationId !== config.applicationId) throw refuse.forbidden(NOT_THIS_APPLICATION);
    return deployment;
  }

  /**
   * §3.4 step 4: the tenant route's cell has a route, written for the same
   * account. A `cell#` value that does not decode is a 500 for every hook
   * put of its tenants (logged as `RouteTableError`); the edge operator
   * role's `PutCellRoute` overwrites it without decoding it, which repairs it.
   */
  private async requireCellRoute(read: ReadKey, cellId: string, accountId: string): Promise<void> {
    const value = await read(cellKey(cellId));
    if (value === undefined || decodeCellEntry(value).ac !== accountId) {
      throw refuse.conflict('the cell of the deployment has no route for its account');
    }
  }
}
