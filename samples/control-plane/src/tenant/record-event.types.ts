// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The shared contract of record events (spec §4.1, §4.3, §4.5, §5.6, §8.4,
 * R-42, R-47 to R-51, ADR-045): the status rules of application, tenant and
 * account records, the execution input the workflow consumes for one
 * record event, the R-42 environment of its hooks, and the operation id the
 * execution is named after. Types, constants and pure functions only: the
 * API (staging, conditional writes, the workflow start) and the workflow
 * (hook loop, commit, terminal writes) each build against this file and
 * never against one another.
 */

import type { AccountPending } from './account.data-model';
import type { ApplicationPending } from './application.data-model';
import { HookEnvVar, HookEvent, HookExecutionInput, HookPhase, ResolvedHook } from './hook.types';
import type { TenantPending } from './tenant.data-model';
import type { ItemKey } from '../shared/repository';
import { LifecycleStatus } from '../smithy/source/typescript-ssdk-codegen/src';

// ---------------------------------------------------------------------------
// Record status (R-47)
// ---------------------------------------------------------------------------

/**
 * The statuses in which an application, tenant or account record is
 * **live**: its live fields are in force, and placement may claim it
 * (R-47, R-13). `CREATING`, `CREATE_FAILED`, `DELETING` and `DELETE_FAILED`
 * are not live.
 */
export const LIVE_STATUSES: readonly LifecycleStatus[] = [
  LifecycleStatus.ACTIVE,
  LifecycleStatus.UPDATING,
  LifecycleStatus.UPDATE_FAILED,
];

/**
 * The status of an application, tenant or account record as stored: a
 * record written before these records had a status has none and reads as
 * `ACTIVE` (R-47); no migration writes it. Every condition MUST treat the
 * absent attribute the same way (`attribute_not_exists(#status) OR ...`).
 */
export function readRecordStatus(stored: LifecycleStatus | undefined): LifecycleStatus {
  return stored ?? LifecycleStatus.ACTIVE;
}

/** Whether a record in `status` is live (R-47). An absent status reads as `ACTIVE`, so it is live. */
export function isLive(status: LifecycleStatus | undefined): boolean {
  return LIVE_STATUSES.includes(readRecordStatus(status));
}

// ---------------------------------------------------------------------------
// Record types and events (§8.4)
// ---------------------------------------------------------------------------

/** The record types whose operations run record events (§8.4). */
export const RECORD_TYPES = ['APPLICATION', 'TENANT', 'ACCOUNT'] as const;
export type RecordType = typeof RECORD_TYPES[number];

/** The nine record events: `<RECORD_TYPE>_<VERB>` (§4.8, §8.4). */
export type RecordEvent = Extract<HookEvent, `${RecordType}_${'CREATE' | 'UPDATE' | 'DELETE'}`>;

/** The verb of a record event; it decides the commit (§8.4). */
export type RecordVerb = 'CREATE' | 'UPDATE' | 'DELETE';

/** Whether `event` is one of the nine record events. */
export function isRecordEvent(event: string): event is RecordEvent {
  const [type, verb, extra] = event.split('_');
  return extra === undefined
    && (RECORD_TYPES as readonly string[]).includes(type)
    && (['CREATE', 'UPDATE', 'DELETE'] as readonly string[]).includes(verb);
}

function split(event: RecordEvent): [RecordType, RecordVerb] {
  if (!isRecordEvent(event)) {
    throw new Error(`Not a record event: ${String(event).slice(0, 40)}`);
  }
  const [type, verb] = event.split('_');
  return [type as RecordType, verb as RecordVerb];
}

/** The record type a record event belongs to: `TENANT_UPDATE` → `TENANT`. */
export function recordTypeOf(event: RecordEvent): RecordType {
  return split(event)[0];
}

/**
 * The attribute a record delete's empty check reads (R-49): `cellCount` on
 * an application or an account, `deploymentCount` on a tenant. The commit
 * of a delete is conditioned on it still being 0 (§8.4).
 */
export const RECORD_COUNT_ATTRIBUTE: Readonly<Record<RecordType, 'cellCount' | 'deploymentCount'>> = {
  APPLICATION: 'cellCount',
  TENANT: 'deploymentCount',
  ACCOUNT: 'cellCount',
};

// ---------------------------------------------------------------------------
// Operation id (R-51)
// ---------------------------------------------------------------------------

/** An operation id is at most this long: 32 + `-application-update-` + 13 + `-` + 8 (R-51), inside Step Functions' 80. */
export const OPERATION_ID_MAX_LENGTH = 74;
/** The charset and length of an operation id; the pattern of the Smithy `OperationId` shape. */
export const OPERATION_ID_PATTERN = /^[A-Za-z0-9-]{1,74}$/;
/** The random suffix: 8 lower-case hex characters, so two operations accepted in the same millisecond differ (R-51). */
export const OPERATION_ID_SUFFIX_PATTERN = /^[0-9a-f]{8}$/;

/**
 * The `operationId` of a record operation, and the name its execution
 * starts under (R-51): the record's id, the operation and the accept time in
 * milliseconds, the shape cell and deployment executions use, plus 8 random
 * hex characters, e.g. `my-app-application-update-1763460000000-0a1b2c3d`.
 * Pure: the caller supplies the clock (`Date.now()`) and the randomness
 * (`randomBytes(4).toString('hex')`). Throws on a malformed argument or a
 * name over {@link OPERATION_ID_MAX_LENGTH}; a record id within its own
 * pattern (application `[a-z0-9-]{1,32}`, tenant ULID, 12-digit account)
 * never exceeds it.
 */
export function newOperationId(recordId: string, op: RecordEvent, nowMs: number, randomHex8: string): string {
  const [type, verb] = split(op);
  if (!/^[A-Za-z0-9-]+$/.test(recordId)) {
    throw new Error('Operation id: the record id must be non-empty [A-Za-z0-9-]');
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error('Operation id: nowMs must be a non-negative integer of milliseconds');
  }
  if (!OPERATION_ID_SUFFIX_PATTERN.test(randomHex8)) {
    throw new Error('Operation id: the random suffix must be 8 lower-case hex characters');
  }
  const name = `${recordId}-${type.toLowerCase()}-${verb.toLowerCase()}-${nowMs}-${randomHex8}`;
  if (name.length > OPERATION_ID_MAX_LENGTH) {
    throw new Error(`Operation id: ${name.length} characters, over the ${OPERATION_ID_MAX_LENGTH} allowed`);
  }
  return name;
}

// ---------------------------------------------------------------------------
// Commit (R-50)
// ---------------------------------------------------------------------------

/**
 * The fields a commit may copy from `pending` into the record, in this
 * order (R-29, R-24, R-48, R-50). `externalId` is never one of them: a
 * replacing `PutAccount` writes it in the request (R-48).
 */
export const RECORD_COMMIT_FIELDS: Readonly<Record<RecordType, readonly string[]>> = {
  APPLICATION: [
    'source',
    'cellScripts',
    'tenantScripts',
    'maxTenants',
    'placementStrategy',
    'parameters',
    'cellParameters',
    'hooks',
  ],
  TENANT: ['name', 'description'],
  ACCOUNT: ['maxCells', 'applicationIds'],
};

/**
 * The fields a commit removes when `pending` does not hold them (R-50): a
 * tenant staged without a description loses it; an account staged without
 * `applicationIds` becomes shared. An application's absent list is **kept**
 * (§5.5), so an application commit removes nothing.
 */
export const RECORD_COMMIT_REMOVABLE_FIELDS: Readonly<Record<RecordType, readonly string[]>> = {
  APPLICATION: [],
  TENANT: ['description'],
  ACCOUNT: ['applicationIds'],
};

/**
 * What the workflow's commit does (R-50, §8.4). `NONE` on a create (the
 * values were written with the insert); `UPDATE` copies each field in
 * `set` from `pending`, REMOVEs each field in `remove` and REMOVEs
 * `pending`, conditioned on `status = UPDATING AND operationId = :op AND
 * attribute_exists(pending)`; `DELETE` deletes the record, conditioned on
 * `status = DELETING AND operationId = :op` and its
 * {@link RECORD_COUNT_ATTRIBUTE} still 0 (R-49). Names only, never values,
 * so the definition stays out of the input (§8.1). `set` and `remove` are
 * empty unless `action` is `UPDATE`.
 */
export interface RecordCommit {
  readonly action: 'NONE' | 'UPDATE' | 'DELETE';
  readonly set: readonly string[];
  readonly remove: readonly string[];
}

/** The staged values of any record type, as {@link recordCommit} reads them. */
export type RecordPending = ApplicationPending | TenantPending | AccountPending;

/**
 * The commit of one record event, decided when the request was validated
 * (R-50). For an `*_UPDATE` event `pending` is the value the request
 * staged: `set` lists the {@link RECORD_COMMIT_FIELDS} it holds and
 * `remove` the {@link RECORD_COMMIT_REMOVABLE_FIELDS} it does not. A create
 * or a delete takes no `pending`. Throws when `pending` is missing on an
 * update or given on a create or delete.
 */
export function recordCommit(event: RecordEvent, pending?: RecordPending): RecordCommit {
  const [type, verb] = split(event);
  if (verb !== 'UPDATE') {
    if (pending !== undefined) {
      throw new Error(`${event} stages nothing: a ${verb.toLowerCase()} takes no pending`);
    }
    return { action: verb === 'CREATE' ? 'NONE' : 'DELETE', set: [], remove: [] };
  }
  if (pending === undefined) {
    throw new Error(`${event} needs the staged pending values`);
  }
  const staged = pending as unknown as Readonly<Record<string, unknown>>;
  return {
    action: 'UPDATE',
    set: RECORD_COMMIT_FIELDS[type].filter((field) => staged[field] !== undefined),
    remove: RECORD_COMMIT_REMOVABLE_FIELDS[type].filter((field) => staged[field] === undefined),
  };
}

// ---------------------------------------------------------------------------
// Hook environment (R-42)
// ---------------------------------------------------------------------------

/**
 * The record an event acts on, as its hooks see it (R-42). On create and
 * update, the values being written (the request's, `pending`'s on an
 * update); on delete, the stored ones. Never an external id, a parameter, a
 * source or a script (R-41, R-42, T46).
 */
export type RecordEventSubject =
  | { readonly recordType: 'APPLICATION'; readonly applicationId: string }
  | { readonly recordType: 'TENANT'; readonly tenantId: string; readonly tenantName: string }
  | {
    readonly recordType: 'ACCOUNT';
    readonly accountId: string;
    readonly owner: 'VENDOR' | 'TENANT';
    /** Absent when the account is (or becomes) shared. */
    readonly applicationIds?: readonly string[];
  };

/**
 * The event-level variables of R-42 for a record event, the same for every
 * hook of the execution. The per-hook ones (`PHASE`, `HOOK_ID`,
 * `HOOK_SCOPE`, `HOOK_SCRIPT`, `ATTEMPT`, `SCRIPT_OUTPUTS`) are added by
 * {@link recordHookEnvironment}. Holds no `PARAM_` variable, no
 * `CELL_ID`, no `ADMIN_EMAIL` and no external id.
 */
export type RecordEventEnvironment = Readonly<Partial<Record<HookEnvVar, string>>>;

/**
 * Builds the event-level R-42 environment of a record event: `EVENT`,
 * `OPERATOR_ID` and `EXECUTION_ID` (the record's `operationId`, R-51), plus
 * `APPLICATION_ID` for an application event, `TENANT_ID` and
 * `TENANT_NAME` for a tenant event, and `ACCOUNT_ID`, `ACCOUNT_OWNER` and
 * `ACCOUNT_APPLICATION_IDS` (the ids joined by `,` in stored order, empty
 * when shared) for an account event. Throws when the event does not belong
 * to the subject's record type.
 */
export function recordEventEnvironment(input: {
  readonly event: RecordEvent;
  readonly subject: RecordEventSubject;
  readonly operatorId: string;
  readonly operationId: string;
}): RecordEventEnvironment {
  const { event, subject, operatorId, operationId } = input;
  if (recordTypeOf(event) !== subject.recordType) {
    throw new Error(`${event} is not an event of a ${subject.recordType.toLowerCase()}`);
  }
  const common = { EVENT: event, OPERATOR_ID: operatorId, EXECUTION_ID: operationId };
  switch (subject.recordType) {
    case 'APPLICATION':
      return { ...common, APPLICATION_ID: subject.applicationId };
    case 'TENANT':
      return { ...common, TENANT_ID: subject.tenantId, TENANT_NAME: subject.tenantName };
    case 'ACCOUNT':
      return {
        ...common,
        ACCOUNT_ID: subject.accountId,
        ACCOUNT_OWNER: subject.owner,
        ACCOUNT_APPLICATION_IDS: (subject.applicationIds ?? []).join(','),
      };
  }
}

/**
 * The full R-42 environment of one hook build of a record event: the
 * event-level variables plus `PHASE`, `HOOK_ID`, `HOOK_SCOPE`,
 * `HOOK_SCRIPT`, `ATTEMPT` and, on `POST`, `SCRIPT_OUTPUTS` `{}` (a commit
 * writes no outputs, R-50). Throws on an application hook on a tenant or
 * account event, which R-50 never runs.
 */
export function recordHookEnvironment(
  environment: RecordEventEnvironment,
  hook: ResolvedHook,
  phase: HookPhase,
  attempt: number,
): RecordEventEnvironment {
  const event = environment.EVENT;
  if (event === undefined || !isRecordEvent(event)) {
    throw new Error('A record hook environment needs a record EVENT');
  }
  if (hook.scope === 'APPLICATION' && recordTypeOf(event) !== 'APPLICATION') {
    throw new Error(`${event} runs global hooks only; ${hook.hookId} is an application hook`);
  }
  return {
    ...environment,
    PHASE: phase,
    HOOK_ID: hook.hookId,
    HOOK_SCOPE: hook.scope,
    HOOK_SCRIPT: hook.script,
    ATTEMPT: String(attempt),
    ...(phase === 'POST' ? { SCRIPT_OUTPUTS: '{}' } : {}),
  };
}

// ---------------------------------------------------------------------------
// Execution input (R-20, R-50, §8.1, §8.4)
// ---------------------------------------------------------------------------

/**
 * The execution input of one record event (R-50): everything the workflow
 * needs, so it never re-reads the record or a hook (R-20). Under 25 KiB at
 * the caps (§8.1): no parameter set, no script source, no external id, no
 * role ARN, and the commit's field names, never their values.
 */
export interface RecordEventInput {
  readonly event: RecordEvent;
  readonly recordType: RecordType;
  /** `applicationId`, `tenantId` or `accountId`. */
  readonly recordId: string;
  /** The record's base-table key (`<TYPE>#<recordId>`, `META`), the target of the commit and the terminal writes. */
  readonly key: ItemKey;
  /** The `operationId` the request stored; also the execution's name. Every workflow write is conditioned on it (R-50, R-51). */
  readonly operationId: string;
  /**
   * The hooks of the event in run order (R-40, R-45): global then
   * application `PRE`, application then global `POST`. A tenant or account
   * event holds global hooks only (R-50). `hooks.event` equals `event`.
   */
  readonly hooks: HookExecutionInput;
  /** The event-level R-42 variables ({@link recordEventEnvironment}). */
  readonly environment: RecordEventEnvironment;
  readonly commit: RecordCommit;
}

/**
 * The workflow's input for a record event: one top-level `recordEvent`, so
 * the state machine tells it from a cell or deployment input
 * (`ProvisioningWorkflowInput` in `tenant.ts`), which never has this field.
 */
export interface RecordEventWorkflowInput {
  readonly recordEvent: RecordEventInput;
}
