// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Name of GSI-1. Cell items use the static partition `CELL` (fleet listing
 * and placement candidate scan); account items use the static partition
 * `ACCOUNT` (account listing and placement account scan); tenant items use
 * `CELL#<cellId>` (per-cell tenant listing). The index projects all
 * attributes (`ProjectionType: ALL`).
 */
export const GSI1_INDEX_NAME = 'GSI1';

/**
 * Name of GSI-2. Tenant items use the static partition `TENANT` (unfiltered
 * tenant listing); cell items use `ACCOUNT#<accountId>` (per-account cell
 * listing and the targeted candidate scan). Account items never appear in
 * it. The index projects all attributes.
 */
export const GSI2_INDEX_NAME = 'GSI2';

/**
 * Base shape of every item in the single-table design: a composite
 * partition/sort key pair built with `KeyBuilder`, plus optional GSI key
 * attributes (§4.5). Idempotency records carry none; account items carry
 * GSI-1 only.
 */
export interface DynamoDBItem {
  readonly PK: string;
  readonly SK: string;
  /** GSI-1 partition key — `CELL` (cells), `ACCOUNT` (accounts), or `CELL#<cellId>` (tenants). */
  readonly GSI1PK?: string;
  /** GSI-1 sort key — `CELL#<cellId>`, `ACCOUNT#<accountId>`, or `TENANT#<tenantId>`. */
  readonly GSI1SK?: string;
  /** GSI-2 partition key — static `TENANT` (tenants) or `ACCOUNT#<accountId>` (cells). */
  readonly GSI2PK?: string;
  /** GSI-2 sort key — `TENANT#<tenantId>` (tenants) or `CELL#<cellId>` (cells). */
  readonly GSI2SK?: string;
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
