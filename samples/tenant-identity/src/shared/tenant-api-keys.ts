// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * One API Gateway key per tenant, in the stack's `/tenant/*` usage plan
 * (ADR-0025). The key is how API Gateway throttles each tenant separately:
 * usage-plan limits apply per key. The authoriser returns the key's value as
 * `usageIdentifierKey` for the tenant it verified, and the API's key source
 * is AUTHORIZER, so a caller never sends or sees a key; any `x-api-key`
 * header is ignored. The key is a throttling identifier, not a credential.
 *
 * Topology-independent: the platform service creates the key during
 * CreateTenant's provision step (ADR-0021) and deletes it on DeleteTenant;
 * the teardown drain deletes it too (ADR-0022).
 *
 * `tiered` (ADR-0027): one usage plan per tier. A premium tenant's key goes
 * in the premium plan, every other key in the stack's (standard) plan. The
 * tier is the caller's choice per key; this module never reads a topology.
 */

import {
  type APIGatewayClient,
  CreateApiKeyCommand,
  CreateUsagePlanKeyCommand,
  DeleteApiKeyCommand,
  GetUsagePlansCommand,
} from '@aws-sdk/client-api-gateway';
import { apiKeyName, STACK_TAG_KEY, type Tier } from './constants';
import { errorName, log } from './logger';

/** What CreateTenant stores on the registry row (ADR-0025). */
export interface TenantApiKey {
  readonly apiKeyId: string;
  readonly apiKeyValue: string;
}

export interface TenantApiKeys {
  /**
   * Creates the tenant's key and adds it to the usage plan. On a usage-plan
   * failure the key just created is deleted (best effort) and the error is
   * rethrown, so a failed call leaves no key behind.
   *
   * `tier` (ADR-0027): `premium` puts the key in the premium tier's plan;
   * `standard` or absent (a single-topology deployment) in the stack's plan.
   */
  create(tenantId: string, tier?: Tier): Promise<TenantApiKey>;
  /** Deletes the key. Idempotent: an absent id or an already-deleted key is not an error. */
  delete(apiKeyId: string | undefined): Promise<void>;
}

/** API Gateway pages GetUsagePlans at most 500 at a time. */
const USAGE_PLAN_PAGE = 500;

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === 'NotFoundException';
}

export class ApiGatewayTenantApiKeys implements TenantApiKeys {
  /** Resolved plan ids by plan name; one in-flight or settled lookup per name. */
  private readonly usagePlanIds = new Map<string, Promise<string>>();

  /**
   * `usagePlanName` is resolved to an id on first use and cached for the
   * life of the execution environment. It is needed only by `create`; the
   * drain and DeleteTenant never resolve it. Pass `undefined` where creating
   * keys is not this function's job (the drain); `create` then throws.
   * `stackName` is the value of the STACK_TAG_KEY tag every key is created
   * with: the roles may create only keys with that tag and delete only keys
   * that carry it (T-7). Also needed only by `create`.
   * `premiumUsagePlanName` (ADR-0027) is the premium tier's plan, set only in
   * a `tiered` deployment; `create(_, 'premium')` throws without it.
   */
  constructor(
    private readonly client: APIGatewayClient,
    private readonly usagePlanName: string | undefined,
    private readonly stackName?: string,
    private readonly premiumUsagePlanName?: string,
  ) {}

  async create(tenantId: string, tier?: Tier): Promise<TenantApiKey> {
    const stackName = this.stackName;
    if (stackName === undefined || stackName === '') {
      // Deployment wiring bug: IAM refuses an untagged key, so fail first.
      throw new Error('Creating a tenant API key requires the stack name');
    }
    const usagePlanId = await this.resolveUsagePlanId(this.planNameFor(tier));
    // A generated value: API Gateway picks it, so it is never derived from
    // the tenant id or anything a caller knows.
    const key = await this.client.send(
      new CreateApiKeyCommand({
        name: apiKeyName(tenantId),
        enabled: true,
        // The delete is IAM-conditioned on this tag (T-7).
        tags: { [STACK_TAG_KEY]: stackName },
      }),
    );
    if (key.id === undefined || key.value === undefined) {
      throw new Error('API Gateway did not return an API key id and value');
    }
    try {
      await this.client.send(
        new CreateUsagePlanKeyCommand({ usagePlanId, keyId: key.id, keyType: 'API_KEY' }),
      );
    } catch (error) {
      // Undo the half-built key so a retry starts clean; the original error
      // surfaces. Log the class name only (N-4).
      await this.delete(key.id).catch((cleanup) => {
        log.error('API key clean-up failed', { tenantId, error: errorName(cleanup) });
      });
      throw error;
    }
    return { apiKeyId: key.id, apiKeyValue: key.value };
  }

  async delete(apiKeyId: string | undefined): Promise<void> {
    if (apiKeyId === undefined) {
      return; // Nothing was created (PROVISIONING row, or a pre-ADR-0025 tenant).
    }
    try {
      // Deleting the key also removes it from every usage plan.
      await this.client.send(new DeleteApiKeyCommand({ apiKey: apiKeyId }));
    } catch (error) {
      if (isNotFound(error)) {
        return; // Already gone; idempotent (P-4).
      }
      throw error;
    }
  }

  /**
   * The plan a key of this tier belongs in (ADR-0027). Absence is a
   * deployment wiring bug: only the platform function creates keys, and only
   * a `tiered` deployment sets the premium plan.
   */
  private planNameFor(tier: Tier | undefined): string {
    if (tier === 'premium') {
      const name = this.premiumUsagePlanName;
      if (name === undefined || name === '') {
        throw new Error('Creating a premium tenant API key requires the premium usage plan name');
      }
      return name;
    }
    const name = this.usagePlanName;
    if (name === undefined || name === '') {
      throw new Error('Creating a tenant API key requires the usage plan name');
    }
    return name;
  }

  private resolveUsagePlanId(name: string): Promise<string> {
    let lookup = this.usagePlanIds.get(name);
    if (lookup === undefined) {
      lookup = this.lookUpUsagePlanId(name);
      // A failed lookup is not cached: the next call retries.
      lookup.catch(() => {
        this.usagePlanIds.delete(name);
      });
      this.usagePlanIds.set(name, lookup);
    }
    return lookup;
  }

  private async lookUpUsagePlanId(name: string): Promise<string> {
    const ids: string[] = [];
    let position: string | undefined;
    do {
      const page = await this.client.send(new GetUsagePlansCommand({ limit: USAGE_PLAN_PAGE, position }));
      for (const plan of page.items ?? []) {
        if (plan.name === name && plan.id !== undefined) {
          ids.push(plan.id);
        }
      }
      position = page.position;
    } while (position !== undefined);
    if (ids.length !== 1) {
      // The name embeds the stack name, so two matches mean another stack or
      // a hand-made plan reuses it. Refuse rather than guess (fail closed).
      throw new Error(`Expected exactly one usage plan named ${name}, found ${ids.length}`);
    }
    return ids[0];
  }
}
