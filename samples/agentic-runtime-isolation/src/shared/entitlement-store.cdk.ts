// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `EntitlementStore` (spec C-12, §4.5; ADR-0030): one DynamoDB table per
 * `SharedIngress`, single-table design, on-demand, PITR on, no TTL, no GSI,
 * the table's default (AWS-owned) encryption, `DESTROY` removal. It holds
 * tenant subscriptions, user cuts, plans, the tool catalogue and name
 * reservations; the agent definition stays in the SSM registry entry.
 *
 * Created by `SharedIngress`; exported for a consumer that builds its own
 * ingress. The grant methods express the role asymmetry of spec §4.5: the
 * ingress reads and never writes; the vendor side of the entitlement API
 * writes tenant and plan rows; the tenant-admin side writes cut rows only
 * under a `TENANT#${aws:PrincipalTag/TenantId}` leading key (ADR-0033).
 */

import { RemovalPolicy } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { KEY_PREFIX, PK, PLAN_INDEX_PK, SK } from './entitlements';
import { TENANT_TAG_KEY } from './tvm';

export { KEY_PREFIX, SORT_KEY, nameKey, planKey, tenantKey, toolKey, userCutKey } from './entitlements';

/** Defaults (spec §3.3). */
export const DEFAULT_MAX_AGENTS_PER_TENANT = 1000;
export const DEFAULT_MAX_TOOLS_PER_TENANT = 1000;

export interface EntitlementStoreProps {
  /** Bound on `agents` in a tenant or plan row. Default 100, at most 100. */
  readonly maxAgentsPerTenant?: number;
  /** Bound on `tools` in a tenant or plan row. Default 1000, at most 1000. */
  readonly maxToolsPerTenant?: number;
}

export class EntitlementStore extends Construct {
  readonly table: dynamodb.TableV2;
  readonly maxAgentsPerTenant: number;
  readonly maxToolsPerTenant: number;

  constructor(scope: Construct, id: string, props: EntitlementStoreProps = {}) {
    super(scope, id);
    const maxAgents = props.maxAgentsPerTenant ?? DEFAULT_MAX_AGENTS_PER_TENANT;
    const maxTools = props.maxToolsPerTenant ?? DEFAULT_MAX_TOOLS_PER_TENANT;
    if (!Number.isInteger(maxAgents) || maxAgents < 1 || maxAgents > DEFAULT_MAX_AGENTS_PER_TENANT) {
      throw new Error(`EntitlementStore: maxAgentsPerTenant must be an integer from 1 to ${DEFAULT_MAX_AGENTS_PER_TENANT} (got ${String(maxAgents)})`);
    }
    if (!Number.isInteger(maxTools) || maxTools < 1 || maxTools > DEFAULT_MAX_TOOLS_PER_TENANT) {
      throw new Error(`EntitlementStore: maxToolsPerTenant must be an integer from 1 to ${DEFAULT_MAX_TOOLS_PER_TENANT} (got ${String(maxTools)})`);
    }
    this.maxAgentsPerTenant = maxAgents;
    this.maxToolsPerTenant = maxTools;
    this.table = new dynamodb.TableV2(this, 'Table', {
      partitionKey: { name: PK, type: dynamodb.AttributeType.STRING },
      sortKey: { name: SK, type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY, // sample only (standard §4.3)
    });
  }

  get tableName(): string {
    return this.table.tableName;
  }

  get tableArn(): string {
    return this.table.tableArn;
  }

  /** The ingress roles (spec §4.5): `BatchGetItem`, `GetItem` and `Query`, never a write. */
  grantIngressRead(role: iam.IRole): void {
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'ReadEntitlements',
        actions: ['dynamodb:BatchGetItem', 'dynamodb:GetItem', 'dynamodb:Query'],
        resources: [this.table.tableArn],
      }),
    );
  }

  /**
   * The vendor side of the entitlement API (SigV4): writes tenant and plan
   * rows and the plan index rows (`PLANS` and `PLAN#<plan>` / `TENANT#<id>`)
   * in one transaction, and deletes a tenant's cut rows with its
   * subscription; reads the
   * catalogue and reservations to validate names. Not the tenant admin's.
   */
  grantVendorWrite(role: iam.IRole): void {
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'VendorEntitlementRows',
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:DeleteItem',
          'dynamodb:ConditionCheckItem',
          'dynamodb:Query',
          'dynamodb:BatchGetItem',
          'dynamodb:BatchWriteItem',
        ],
        resources: [this.table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [`${KEY_PREFIX.tenant}*`, `${KEY_PREFIX.plan}*`, PLAN_INDEX_PK] } },
      }),
    );
    this.grantCatalogueRead(role, 'VendorReadCatalogue');
  }

  /** Reads of plans, the catalogue and reservations: what name validation needs, no tenant row. */
  grantCatalogueRead(role: iam.IRole, sid = 'ReadCatalogue'): void {
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid,
        actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:BatchGetItem'],
        resources: [this.table.tableArn],
        conditions: {
          'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [`${KEY_PREFIX.plan}*`, `${KEY_PREFIX.tool}*`, `${KEY_PREFIX.name}*`] },
        },
      }),
    );
  }

  /**
   * The tenant-admin role the entitlement API assumes with a `TenantId`
   * session tag from the verified identity token (ADR-0033): every item
   * call is limited to the caller's own tenant partition, so a cut for
   * another tenant fails in IAM whatever the handler does (P-8 applied to
   * the store). `TransactWriteItems` is authorised per item action.
   */
  grantTenantAdminPartition(role: iam.IRole): void {
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'OwnTenantPartitionOnly',
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:ConditionCheckItem'],
        resources: [this.table.tableArn],
        conditions: {
          'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [`${KEY_PREFIX.tenant}\${aws:PrincipalTag/${TENANT_TAG_KEY}}`] },
        },
      }),
    );
  }
}
