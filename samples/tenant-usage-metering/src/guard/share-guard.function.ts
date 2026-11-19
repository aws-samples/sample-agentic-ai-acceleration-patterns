// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Lambda entry of the bus share guard, the `onEvent` handler of a
 * custom-resource provider (ADR-0006). Create and Update read the registry
 * and throw when an account in `AccountIds` holds a registered cell, which
 * fails the deploy before the AWS RAM shares change. Delete does nothing.
 */

import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { offendingEmitters, refusal } from './share-guard';
import { documentClient } from '../shared/db';
import { ENV, requireEnv } from '../shared/env';
import { log } from '../shared/logger';

const PHYSICAL_ID = 'bus-share-guard';

export const handler = async (event: CloudFormationCustomResourceEvent): Promise<{ PhysicalResourceId: string }> => {
  const physicalResourceId = event.RequestType === 'Create' ? PHYSICAL_ID : event.PhysicalResourceId;
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: physicalResourceId };
  }
  const accountIds = (event.ResourceProperties.AccountIds ?? []) as string[];
  const found = await offendingEmitters(documentClient(), requireEnv(ENV.tableName), accountIds, Date.now());
  if (found.length > 0) {
    log.error('bus share refused', { operation: event.RequestType, count: found.length });
    throw new Error(refusal(found));
  }
  return { PhysicalResourceId: physicalResourceId };
};
