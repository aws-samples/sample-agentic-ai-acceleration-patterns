// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The construct's props (spec §3.3) and their synth-time checks. Every
 * check fails synth with a message that names the input; a value that would
 * break a guarantee of the spec is never silently corrected.
 */

import { Token } from 'aws-cdk-lib';

export type IngestPath = 'BUS' | 'DIRECT';

export interface TenantUsageMeteringProps {
  /** The control plane's fleet name, `[a-z0-9][a-z0-9-]{0,31}`. */
  readonly fleetName: string;
  /** Roles that may register emitters and tenant bindings (the control plane's `<fleet>-global-hook`). */
  readonly registrarPrincipalArns: string[];
  /** Roles that may manage meters, sinks, recounts, re-admission, redrives and resends. */
  readonly operatorPrincipalArns: string[];
  /** Roles that may read usage. @default [] */
  readonly readerPrincipalArns?: string[];
  /** Minutes after an hour ends before it is first counted; at least 6. @default 15 */
  readonly lateGraceMinutes?: number;
  /** Hours after an hour ends it may still be recounted; at least 72. @default 96 */
  readonly recountWindowHours?: number;
  /** Minutes a closing registration still admits buffered events. @default 60 */
  readonly closeGraceMinutes?: number;
  /** Raw and re-admitted object lifetime, days. @default 400 */
  readonly rawRetentionDays?: number;
  /** Error object lifetime, days; at least ceil(recountWindowHours / 24) + 7. @default 30 */
  readonly errorRetentionDays?: number;
  /** Per-emitter admission limit. @default 3000 */
  readonly maxEventsPerEmitterPerMinute?: number;
  /** Refusals that can never count, stored per emitter and hour. @default 10000 */
  readonly maxRefusedPerEmitterPerHour?: number;
  /** `BUS` (ADR-0002) or `DIRECT`. @default 'BUS' */
  readonly ingestPath?: IngestPath;
  /** Ingest bus retention, days. @default 1 */
  readonly ingestBusRetentionDays?: number;
  /** Usage bus retention, days. @default 7 */
  readonly usageBusRetentionDays?: number;
  /**
   * Vendor accounts the ingest bus is shared with through AWS RAM, under the
   * SubscribeOnly permission (ADR-0006). `BUS` only: a non-empty list on
   * `DIRECT`, which has no ingest bus, fails synth. None of them may hold an
   * emitter: `PutEmitter` refuses one there, and a deploy that adds an
   * account already holding an emitter that can still send fails. Neither
   * list may name the metering account, which reads its buses directly.
   * @default []
   */
  readonly rawSubscriberAccountIds?: string[];
  /**
   * Vendor accounts the usage bus is shared with through AWS RAM, under the
   * SubscribeOnly permission (ADR-0006). None of them may hold an emitter:
   * `PutEmitter` refuses one there, and a deploy that adds an account
   * already holding an emitter that can still send fails. It may not name
   * the metering account, which reads its buses directly. @default []
   */
  readonly usageSubscriberAccountIds?: string[];
  /**
   * The role CloudFormation runs as, exempt from the bucket configuration
   * denies (spec §3.5). @default the bootstrap `cfn-exec` role
   */
  readonly deploymentRoleArn?: string;
  /** SNS topic for every alarm. @default none */
  readonly alarmTopicArn?: string;
  /**
   * TEST ONLY: let `PutEmitter` register an emitter in the metering account,
   * so a one-account integration test can run one. An emitter there could
   * read the raw store's account; never set it in a real deployment
   * (spec §3.2). @default false
   */
  readonly testOnlyAllowEmittersInMeteringAccount?: boolean;
}

/** The props with every default applied. */
export interface ResolvedProps extends Required<Omit<TenantUsageMeteringProps, 'deploymentRoleArn' | 'alarmTopicArn' | 'testOnlyAllowEmittersInMeteringAccount'>> {
  readonly testOnlyAllowEmittersInMeteringAccount: boolean;
  readonly deploymentRoleArn?: string;
  readonly alarmTopicArn?: string;
}

const FLEET = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ACCOUNT = /^[0-9]{12}$/;
const ROLE_ARN = /^arn:aws[a-z-]*:iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/;

function integer(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}, got ${value}`);
  }
}

function roleArns(name: string, values: string[], required: boolean): void {
  if (required && values.length === 0) {
    throw new Error(`${name} must name at least one role`);
  }
  for (const value of values) {
    if (!Token.isUnresolved(value) && !ROLE_ARN.test(value)) {
      throw new Error(`${name} holds ${JSON.stringify(value)}, which is not an IAM role ARN`);
    }
  }
}

function accounts(name: string, values: string[], meteringAccount: string | undefined): void {
  for (const value of values) {
    if (!Token.isUnresolved(value) && !ACCOUNT.test(value)) {
      throw new Error(`${name} holds ${JSON.stringify(value)}, which is not a 12-digit account id`);
    }
    if (meteringAccount !== undefined && !Token.isUnresolved(meteringAccount) && value === meteringAccount) {
      throw new Error(`${name} holds the metering account ${value}, which reads its buses directly and needs no share`);
    }
  }
}

/**
 * Applies the defaults of spec §3.3 and fails synth on any value it refuses.
 * `meteringAccount` is the stack's account; a token skips the checks on it.
 */
export function resolveProps(props: TenantUsageMeteringProps, meteringAccount?: string): ResolvedProps {
  const resolved: ResolvedProps = {
    fleetName: props.fleetName,
    registrarPrincipalArns: props.registrarPrincipalArns,
    operatorPrincipalArns: props.operatorPrincipalArns,
    readerPrincipalArns: props.readerPrincipalArns ?? [],
    lateGraceMinutes: props.lateGraceMinutes ?? 15,
    recountWindowHours: props.recountWindowHours ?? 96,
    closeGraceMinutes: props.closeGraceMinutes ?? 60,
    rawRetentionDays: props.rawRetentionDays ?? 400,
    errorRetentionDays: props.errorRetentionDays ?? 30,
    maxEventsPerEmitterPerMinute: props.maxEventsPerEmitterPerMinute ?? 3000,
    maxRefusedPerEmitterPerHour: props.maxRefusedPerEmitterPerHour ?? 10000,
    ingestPath: props.ingestPath ?? 'BUS',
    ingestBusRetentionDays: props.ingestBusRetentionDays ?? 1,
    usageBusRetentionDays: props.usageBusRetentionDays ?? 7,
    rawSubscriberAccountIds: props.rawSubscriberAccountIds ?? [],
    usageSubscriberAccountIds: props.usageSubscriberAccountIds ?? [],
    deploymentRoleArn: props.deploymentRoleArn,
    alarmTopicArn: props.alarmTopicArn,
    testOnlyAllowEmittersInMeteringAccount: props.testOnlyAllowEmittersInMeteringAccount ?? false,
  };

  if (!FLEET.test(resolved.fleetName)) {
    throw new Error(`fleetName must match [a-z0-9][a-z0-9-]{0,31}, got ${JSON.stringify(resolved.fleetName)}`);
  }
  roleArns('registrarPrincipalArns', resolved.registrarPrincipalArns, true);
  roleArns('operatorPrincipalArns', resolved.operatorPrincipalArns, true);
  roleArns('readerPrincipalArns', resolved.readerPrincipalArns, false);
  const others = new Set([...resolved.operatorPrincipalArns, ...resolved.readerPrincipalArns]);
  for (const arn of resolved.registrarPrincipalArns) {
    if (others.has(arn)) {
      throw new Error(`${arn} is both a registrar and an operator or reader; the registrar must be a role of its own (spec §3.3)`);
    }
  }
  if (resolved.deploymentRoleArn !== undefined) {
    roleArns('deploymentRoleArn', [resolved.deploymentRoleArn], true);
  }

  integer('lateGraceMinutes', resolved.lateGraceMinutes, 6, 1440);
  integer('recountWindowHours', resolved.recountWindowHours, 72, 24 * 31);
  integer('closeGraceMinutes', resolved.closeGraceMinutes, 1, 1440);
  integer('rawRetentionDays', resolved.rawRetentionDays, 1, 3650);
  integer('errorRetentionDays', resolved.errorRetentionDays, Math.ceil(resolved.recountWindowHours / 24) + 7, 3650);
  integer('maxEventsPerEmitterPerMinute', resolved.maxEventsPerEmitterPerMinute, 1, 1_000_000);
  integer('maxRefusedPerEmitterPerHour', resolved.maxRefusedPerEmitterPerHour, 0, 10_000_000);
  integer('ingestBusRetentionDays', resolved.ingestBusRetentionDays, 1, 365);
  integer('usageBusRetentionDays', resolved.usageBusRetentionDays, 1, 365);
  if (resolved.rawRetentionDays * 24 < resolved.recountWindowHours) {
    throw new Error('rawRetentionDays must cover recountWindowHours: the recount reads raw objects for the whole window');
  }
  if (resolved.ingestPath !== 'BUS' && resolved.ingestPath !== 'DIRECT') {
    throw new Error(`ingestPath must be BUS or DIRECT, got ${JSON.stringify(resolved.ingestPath)}`);
  }
  accounts('rawSubscriberAccountIds', resolved.rawSubscriberAccountIds, meteringAccount);
  accounts('usageSubscriberAccountIds', resolved.usageSubscriberAccountIds, meteringAccount);
  if (resolved.ingestPath === 'DIRECT' && resolved.rawSubscriberAccountIds.length > 0) {
    throw new Error('rawSubscriberAccountIds needs ingestPath BUS: DIRECT has no ingest bus to share');
  }
  return resolved;
}
