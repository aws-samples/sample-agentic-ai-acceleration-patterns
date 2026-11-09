// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The validator contract (spec §3.5, P-11, ADR-0008, M-20). A validator is
 * a function the deployer owns, in any language or account; the chain
 * hands it a short-lived, single-object, ETag-pinned GET signed by the
 * tenant session and takes back a verdict. It holds no AWS permission of
 * the pipeline's, so a bad one can read one document for a few minutes.
 *
 * `bind` grants the processor what it needs to call the validator and
 * nothing else; the validator's own role gains nothing. A cross-account
 * validator needs its own resource policy admitting `processorRole`, which
 * the deployer owns. The contract names no carrier beyond `lambda` today;
 * a Step Functions carrier is a seam (spec §11).
 */

import { Duration } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

export interface IDeliveryValidator {
  /** `[a-z0-9-]{1,32}`, unique in the chain; the reason prefix `<name>:<code>`. */
  readonly name: string;
  /** At most 10 minutes; part of the processor timeout T (spec §8 "Timing"). */
  readonly timeout: Duration;
  readonly carrier: 'lambda';
  readonly functionArn: string;
  /** Grants `processor` invoke, nothing else. */
  bind(scope: Construct, processor: iam.IGrantable): void;
}

export const VALIDATOR_NAME_PATTERN = /^[a-z0-9-]{1,32}$/;
export const MAX_VALIDATOR_TIMEOUT = Duration.minutes(10);

export interface LambdaValidatorOptions {
  /** Default `lambda`; must be unique in the chain. */
  readonly name?: string;
  /**
   * The verdict budget the chain plans for. Default 1 minute. Declare at
   * least the function's own timeout: a validator whose function runs
   * longer than it declares can outlast the processor (spec §10 step 7c
   * uses exactly that).
   */
  readonly timeout?: Duration;
}

/** A validator carried by a Lambda function (spec §3.5). */
export class LambdaValidator implements IDeliveryValidator {
  readonly name: string;
  readonly timeout: Duration;
  readonly carrier = 'lambda' as const;
  readonly functionArn: string;

  constructor(private readonly fn: lambda.IFunction, options: LambdaValidatorOptions = {}) {
    this.name = options.name ?? 'lambda';
    this.timeout = options.timeout ?? Duration.minutes(1);
    this.functionArn = fn.functionArn;
    if (!VALIDATOR_NAME_PATTERN.test(this.name)) {
      throw new Error(`LambdaValidator: name '${this.name}' must match ${VALIDATOR_NAME_PATTERN.source}`);
    }
    if (this.timeout.toSeconds() < 1 || this.timeout.toSeconds() > MAX_VALIDATOR_TIMEOUT.toSeconds()) {
      throw new Error(`LambdaValidator ${this.name}: timeout must be 1 second to 10 minutes`);
    }
  }

  bind(_scope: Construct, processor: iam.IGrantable): void {
    // The exact function ARN: grantInvoke would add a `:*` version wildcard.
    iam.Grant.addToPrincipal({ grantee: processor, actions: ['lambda:InvokeFunction'], resourceArns: [this.fn.functionArn] });
  }
}
