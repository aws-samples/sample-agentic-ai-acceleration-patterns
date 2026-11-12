// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Name of GSI-1. Static partitions `CELL` (fleet listing), `ACCOUNT`
 * (account listing and the placement account scan) and `APPLICATION`
 * (application listing); deployment items use `CELL#<cellId>` (per-cell
 * deployment listing). The index projects all attributes
 * (`ProjectionType: ALL`).
 */
export const GSI1_INDEX_NAME = 'GSI1';

/**
 * Name of GSI-2. Static partitions `TENANT` (unfiltered tenant listing) and
 * `DEPLOYMENT` (unfiltered deployment listing); cell items use
 * `ACCOUNT#<accountId>` (per-account cell listing and the targeted
 * candidate scan). Account and application items never appear in it. The
 * index projects all attributes.
 */
export const GSI2_INDEX_NAME = 'GSI2';

/**
 * Name of GSI-3. One partition shape, `APPLICATION#<applicationId>`, shared
 * by cell items (`CELL#<cellId>` sort keys: per-application cell listing and
 * the untargeted candidate scan) and deployment items
 * (`DEPLOYMENT#<tenantId>` sort keys: per-application deployment listing),
 * separated by sort-key prefix. The index projects all attributes.
 */
export const GSI3_INDEX_NAME = 'GSI3';

/**
 * Base shape of every item in the single-table design: a composite
 * partition/sort key pair built with `KeyBuilder`, plus optional GSI key
 * attributes (spec §4.7). Each item carries at most one partition per index:
 * idempotency records carry none, tenants GSI-2 only, accounts and
 * applications GSI-1 only, cells and deployments all three.
 */
export interface DynamoDBItem {
  readonly PK: string;
  readonly SK: string;
  /** GSI-1 partition key — `CELL`, `ACCOUNT`, `APPLICATION`, or `CELL#<cellId>` (deployments). */
  readonly GSI1PK?: string;
  /** GSI-1 sort key — `CELL#<cellId>`, `ACCOUNT#<accountId>`, `APPLICATION#<id>`, or `DEPLOYMENT#<tenantId>`. */
  readonly GSI1SK?: string;
  /** GSI-2 partition key — static `TENANT`, static `DEPLOYMENT`, or `ACCOUNT#<accountId>` (cells). */
  readonly GSI2PK?: string;
  /** GSI-2 sort key — `TENANT#<tenantId>`, `DEPLOYMENT#<tenantId>#<applicationId>`, or `CELL#<cellId>`. */
  readonly GSI2SK?: string;
  /** GSI-3 partition key — `APPLICATION#<applicationId>` (cells and deployments). */
  readonly GSI3PK?: string;
  /** GSI-3 sort key — `CELL#<cellId>` (cells) or `DEPLOYMENT#<tenantId>` (deployments). */
  readonly GSI3SK?: string;
}

/**
 * Converts between domain schemas (Smithy-generated shapes) and DynamoDB
 * items. The data model owns key building — it receives the identifiers it
 * needs (e.g. `tenantId`) at call time — and GSI attribute stamping.
 *
 * @typeParam TSchema — the domain shape (from the generated SSDK)
 * @typeParam TItem — the DynamoDB item shape (extends {@link DynamoDBItem})
 */
export interface DataModel<TSchema, TItem extends DynamoDBItem> {
  /** Converts a domain schema to its DynamoDB item representation. */
  toItem(schema: TSchema): TItem;

  /** Converts a DynamoDB item back to the domain schema. */
  fromItem(item: TItem): TSchema;
}
