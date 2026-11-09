// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The pipeline's timing and its processor (spec §8 "Timing", ADR-0009,
 * M-11, M-21).
 *
 * T = structural budget + every validator's declared timeout + copy budget,
 * at most 15 minutes (the Lambda limit), else synth fails naming the
 * validators. The processor's timeout is T; the queue's visibility timeout
 * is `visibilityTimeoutFactor x T`, so a message is not redelivered while a
 * run can still hold its lease; the DLQ is reached after at most
 * `maxReceiveCount x visibilityTimeoutFactor x T` (18T by default).
 */

import { Duration } from 'aws-cdk-lib';
import type * as iam from 'aws-cdk-lib/aws-iam';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import type * as logs from 'aws-cdk-lib/aws-logs';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { createFunction, type FunctionWithLogs, MAX_FUNCTION_TIMEOUT } from './functions';
import type { IDeliveryValidator } from '../validators/lambda-validator';

/** Budget of steps 0 to 4: sessions, registry reads, the lease, HeadObject and one streamed read of up to the size limit. */
export const STRUCTURAL_BUDGET = Duration.seconds(60);
/** Budget of steps 6 to 9: the copy, the flip, the delete and the event. */
export const COPY_BUDGET = Duration.seconds(60);

/** T (spec §8). Throws, naming the validators, when it exceeds 15 minutes. */
export function processorTimeout(validators: readonly IDeliveryValidator[]): Duration {
  const seconds =
    STRUCTURAL_BUDGET.toSeconds() + validators.reduce((sum, v) => sum + v.timeout.toSeconds(), 0) + COPY_BUDGET.toSeconds();
  if (seconds > MAX_FUNCTION_TIMEOUT.toSeconds()) {
    throw new Error(
      `TenantEncryptedIngestion: the processor timeout T = ${seconds} s exceeds 900 s; reduce the timeouts of validators ${validators
        .map((v) => v.name)
        .join(', ')} (spec §8 "Timing")`,
    );
  }
  return Duration.seconds(seconds);
}

export interface ProcessorProps {
  readonly role: iam.Role;
  readonly queue: sqs.IQueue;
  readonly timeout: Duration;
  readonly environment: Record<string, string>;
  readonly logRetention: logs.RetentionDays;
}

export function createProcessorFunction(scope: Construct, props: ProcessorProps): FunctionWithLogs {
  const processor = createFunction(scope, 'ProcessorFunction', {
    entry: 'processor/handler.ts',
    role: props.role,
    timeout: props.timeout,
    memorySize: 1024,
    environment: props.environment,
    logRetention: props.logRetention,
    description: 'tenant-encrypted-ingestion processor: validate, then land, under the tenant session (spec §8)',
  });
  // One message per run: T is the budget of one delivery.
  processor.fn.addEventSource(new SqsEventSource(props.queue, { batchSize: 1, reportBatchItemFailures: true }));
  return processor;
}
