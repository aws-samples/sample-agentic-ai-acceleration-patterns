// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The starter (spec §3.4 step 5): a custom resource deployed with the
 * sweeper and after it. On Create, which is the stack created with
 * `dedicatedDomains` on or the update that turns it on, it invokes the
 * sweeper function asynchronously with the daily schedule's input, so the
 * no-lister alarm has a datapoint within minutes of deployment. No
 * `tenant#` entry holds a `d` then, so that run sets `pagesStarted` to 0
 * and emits a missing-pages count of 0. It does not wait for the run: a
 * failed deploy-time run does not fail the deployment. Every other event
 * does nothing.
 */

import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { CustomResourceEventBase, CustomResourceOutcome, respond } from './cfn-response';
import { SWEEPER_RECHECK_INPUT, type SweeperStarterProperties } from '../shared/contracts';

export const PHYSICAL_RESOURCE_ID = 'sweeper-starter';

/** Each invoke request's limit, well inside the function's timeout so the answer always goes out. */
export const INVOKE_TIMEOUT_MS = 10_000;

export interface SweeperStarterEvent extends CustomResourceEventBase {
  readonly RequestType: 'Create' | 'Update' | 'Delete';
  readonly PhysicalResourceId?: string;
  readonly ResourceProperties: SweeperStarterProperties & { readonly ServiceToken?: string };
}

export interface Deps {
  readonly lambda: Pick<LambdaClient, 'send'>;
}

export async function handleEvent(event: SweeperStarterEvent, deps: Deps): Promise<CustomResourceOutcome> {
  const physicalResourceId = event.PhysicalResourceId ?? PHYSICAL_RESOURCE_ID;
  if (event.RequestType !== 'Create') return { status: 'SUCCESS', physicalResourceId };
  const functionName = event.ResourceProperties.SweeperFunctionName;
  if (typeof functionName !== 'string' || functionName === '') {
    return { status: 'FAILED', physicalResourceId, reason: 'SweeperFunctionName is required' };
  }
  try {
    // An asynchronous invoke: Lambda queues the run and answers 202.
    await deps.lambda.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'Event',
      Payload: Buffer.from(SWEEPER_RECHECK_INPUT),
    }));
  } catch (error) {
    // A refused invoke (a missing grant, a missing function) fails the
    // resource, so the deployment shows it (§3.4 step 5).
    return { status: 'FAILED', physicalResourceId, reason: `sweeper invoke failed: ${error instanceof Error ? error.name : 'UnknownError'}` };
  }
  return { status: 'SUCCESS', physicalResourceId };
}

const deps: Deps = { lambda: new LambdaClient({ requestHandler: { requestTimeout: INVOKE_TIMEOUT_MS } }) };

export const handler = async (event: SweeperStarterEvent): Promise<void> => {
  let outcome: CustomResourceOutcome;
  try {
    outcome = await handleEvent(event, deps);
  } catch (error) {
    outcome = { status: 'FAILED', physicalResourceId: event.PhysicalResourceId ?? PHYSICAL_RESOURCE_ID, reason: error instanceof Error ? error.name : 'UnknownError' };
  }
  await respond(event, outcome);
};
