// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { PreTokenGenerationV2TriggerEvent, PreTokenGenerationV2TriggerHandler } from 'aws-lambda';
import { handlePreTokenGeneration } from './pre-token-generation';
import { ENV, parseDeployment, requireEnv } from '../shared/constants';
import { DynamoDBRegistry } from '../shared/registry';
import { CachedScopeCatalogue } from '../shared/scope-catalogue';
import { createTenantSource } from '../topology';

/**
 * The Cognito pre-token-generation (V2) Lambda entry (R-4, spec §8). Cold
 * start builds the registry reader, the topology's tenant source and the
 * scope catalogue cache once; the request path is the pure core in
 * `pre-token-generation.ts`.
 *
 * The role holds only registry reads plus logging (R-14): this handler
 * constructs a DynamoDB document client and nothing Cognito-side.
 */

const deployment = parseDeployment(process.env[ENV.topology]);
const tableName = requireEnv(ENV.tableName);
const poolIndexName = requireEnv(ENV.poolIndexName);

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const registry = new DynamoDBRegistry(tableName, documentClient, poolIndexName);
const source = createTenantSource(deployment);
// ADR-0034: the catalogue, re-read at most once a minute per container.
const catalogue = new CachedScopeCatalogue(registry);

export const handler: PreTokenGenerationV2TriggerHandler = async (
  event: PreTokenGenerationV2TriggerEvent,
): Promise<PreTokenGenerationV2TriggerEvent> => {
  // Any error propagates so Cognito fails the token request (§8 "Failure
  // mode"): a token without a tenant claim is never returned.
  return handlePreTokenGeneration(event, { source, registry, catalogue });
};
