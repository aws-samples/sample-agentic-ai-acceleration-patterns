// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  APPLICATION_SCRIPT_PATH_PATTERN,
  APPLICATION_SOURCE_LOCATION_PATTERN,
  APPLICATION_SOURCE_VERSION_PATTERN,
  DEFAULT_HOOK_TIMEOUT_MINUTES,
  GLOBAL_ONLY_HOOK_EVENTS,
  GlobalHookRecord,
  HOOK_EVENTS,
  HOOK_ID_PATTERN,
  HOOK_PHASES,
  HOOK_SCRIPT_PATH_PATTERN,
  HOOK_SOURCE_LOCATION_PATTERN,
  HOOK_SOURCE_TYPES,
  HOOK_SOURCE_VERSION_PATTERN,
  HOOK_TIMEOUT_MINUTES_MAX,
  HOOK_TIMEOUT_MINUTES_MIN,
  HookDefinition,
  HookEvent,
  HookExecutionInput,
  HookPhase,
  MAX_APPLICATION_HOOKS,
  ResolvedHook,
} from './hook.types';
import { isFullCommitSha } from '../shared/service-config';
import { ValidationException } from '../smithy/source/typescript-ssdk-codegen/src';

/**
 * Validation, stamping and resolution of hooks (spec §4.8, R-39, R-40,
 * R-45). Pure functions: the service reads the records, these decide, the
 * service writes.
 *
 * Messages name the hook and the field, never the value: a source location
 * may hold userinfo an operator pasted by mistake, and messages reach logs
 * and clients (R-39, N-12).
 */

/** The shape a request carries for one hook; the generated type has every member optional. */
export interface HookDefinitionInput {
  readonly hookId?: string;
  readonly events?: readonly string[];
  readonly phase?: string;
  readonly source?: { readonly type?: string; readonly location?: string; readonly sourceVersion?: string };
  readonly script?: string;
  readonly timeoutMinutes?: number;
}

function invalid(message: string): ValidationException {
  return new ValidationException({ message });
}

/**
 * Validates one hook definition against R-39 and returns it with the
 * timeout resolved (stored resolved, so a stamp and a record always carry it,
 * §4.8). `where` names the hook in every message ("Hook x", "Application a,
 * hook x").
 */
export function validateHookDefinition(input: HookDefinitionInput, where: string): HookDefinition {
  const { hookId, events, phase, source, script, timeoutMinutes } = input;
  if (typeof hookId !== 'string' || !HOOK_ID_PATTERN.test(hookId)) {
    throw invalid(`${where}: hookId must match ${HOOK_ID_PATTERN.source}`);
  }
  if (!Array.isArray(events) || events.length === 0) {
    throw invalid(`${where}: events must name at least one event`);
  }
  const unknownEvent = events.find((event) => !(HOOK_EVENTS as readonly string[]).includes(event));
  if (unknownEvent !== undefined) {
    throw invalid(`${where}: unknown event ${JSON.stringify(String(unknownEvent).slice(0, 40))}; expected one of ${HOOK_EVENTS.join(', ')}`);
  }
  if (new Set(events).size !== events.length) {
    throw invalid(`${where}: events must not repeat an event`);
  }
  if (typeof phase !== 'string' || !(HOOK_PHASES as readonly string[]).includes(phase)) {
    throw invalid(`${where}: phase must be one of ${HOOK_PHASES.join(', ')}`);
  }
  if (source === undefined || source === null || typeof source !== 'object') {
    throw invalid(`${where}: source is required`);
  }
  if (typeof source.type !== 'string' || !(HOOK_SOURCE_TYPES as readonly string[]).includes(source.type)) {
    throw invalid(`${where}: source.type must be one of ${HOOK_SOURCE_TYPES.join(', ')}`);
  }
  if (typeof source.location !== 'string' || !HOOK_SOURCE_LOCATION_PATTERN.test(source.location)) {
    throw invalid(
      `${where}: source.location must be 1 to 1,024 URL characters with no '@' (a location carries no userinfo) and no control character`,
    );
  }
  if (source.sourceVersion !== undefined
    && (typeof source.sourceVersion !== 'string' || !HOOK_SOURCE_VERSION_PATTERN.test(source.sourceVersion))) {
    throw invalid(`${where}: source.sourceVersion must be 1 to 128 characters of [A-Za-z0-9._/^{}+-]`);
  }
  if (typeof script !== 'string' || !HOOK_SCRIPT_PATH_PATTERN.test(script)) {
    throw invalid(`${where}: script must be 1 to 256 characters of [A-Za-z0-9._/-]`);
  }
  if (timeoutMinutes !== undefined
    && (!Number.isInteger(timeoutMinutes) || timeoutMinutes < HOOK_TIMEOUT_MINUTES_MIN || timeoutMinutes > HOOK_TIMEOUT_MINUTES_MAX)) {
    throw invalid(`${where}: timeoutMinutes must be an integer from ${HOOK_TIMEOUT_MINUTES_MIN} to ${HOOK_TIMEOUT_MINUTES_MAX}`);
  }
  return {
    hookId,
    events: events as HookEvent[],
    phase: phase as HookPhase,
    source: {
      type: source.type as HookDefinition['source']['type'],
      location: source.location,
      ...(source.sourceVersion === undefined ? {} : { sourceVersion: source.sourceVersion }),
    },
    script,
    timeoutMinutes: timeoutMinutes ?? DEFAULT_HOOK_TIMEOUT_MINUTES,
  };
}

/**
 * Validates an application's `hooks` list (R-39): at most
 * {@link MAX_APPLICATION_HOOKS}, each a valid definition naming no
 * `TENANT_*` or `ACCOUNT_*` event ({@link GLOBAL_ONLY_HOOK_EVENTS}), no
 * `hookId` twice. `undefined` (not sent) stays `undefined`: the list is kept
 * (§5.5).
 */
export function validateApplicationHooks(
  hooks: readonly HookDefinitionInput[] | undefined,
  applicationId: string,
): HookDefinition[] | undefined {
  if (hooks === undefined) {
    return undefined;
  }
  if (hooks.length > MAX_APPLICATION_HOOKS) {
    throw invalid(`Application ${applicationId}: hooks holds ${hooks.length} entries; at most ${MAX_APPLICATION_HOOKS} are allowed`);
  }
  const seen = new Set<string>();
  return hooks.map((hook) => {
    const definition = validateHookDefinition(hook, `Application ${applicationId}, hook ${describeId(hook.hookId)}`);
    const globalOnly = definition.events.find((event) => GLOBAL_ONLY_HOOK_EVENTS.includes(event));
    if (globalOnly !== undefined) {
      throw invalid(
        `Application ${applicationId}, hook ${definition.hookId}: an application hook may not name ${globalOnly}; `
        + 'tenant and account events run global hooks only (register it with PutHook)',
      );
    }
    if (seen.has(definition.hookId)) {
      throw invalid(`Application ${applicationId}: hookId ${definition.hookId} appears more than once in hooks`);
    }
    seen.add(definition.hookId);
    return definition;
  });
}

/** An id safe to put in a message: only the hook charset, else a placeholder. */
function describeId(hookId: string | undefined): string {
  return typeof hookId === 'string' && HOOK_ID_PATTERN.test(hookId) ? hookId : '(invalid id)';
}

/**
 * The charsets of an application's own source and script paths (§4.1, R-39,
 * ADR-044): the hook charsets, so a definition is as large in the execution
 * input as it is raw (§8.1). A 400 names the field, never the value.
 */
export function validateApplicationDefinition(
  applicationId: string,
  source: { readonly location: string; readonly sourceVersion?: string },
  scripts: Readonly<Record<'cellScripts' | 'tenantScripts', Readonly<Record<'create' | 'update' | 'delete', string>>>>,
): void {
  if (!APPLICATION_SOURCE_LOCATION_PATTERN.test(source.location)) {
    throw invalid(
      `Application ${applicationId}: source.location must be 1 to 2,048 URL characters with no '@' (a location carries no userinfo) and no control character`,
    );
  }
  if (source.sourceVersion !== undefined && !APPLICATION_SOURCE_VERSION_PATTERN.test(source.sourceVersion)) {
    throw invalid(`Application ${applicationId}: source.sourceVersion must be 1 to 256 characters of [A-Za-z0-9._/^{}+-]`);
  }
  for (const group of ['cellScripts', 'tenantScripts'] as const) {
    for (const verb of ['create', 'update', 'delete'] as const) {
      if (!APPLICATION_SCRIPT_PATH_PATTERN.test(scripts[group][verb])) {
        throw invalid(`Application ${applicationId}: ${group}.${verb} must be 1 to 1,024 characters of [A-Za-z0-9._/-]`);
      }
    }
  }
}

/**
 * The warning for a hook whose source ref is not a full commit SHA (ADR-020):
 * the hook runs under a hook role and a mutable ref lets a poisoned commit
 * run there (T5). `undefined` when pinned. Warn-and-allow, like the
 * application's own source.
 */
export function hookPinningWarning(definition: HookDefinition): string | undefined {
  const ref = definition.source.sourceVersion;
  if (isFullCommitSha(ref)) {
    return undefined;
  }
  const got = ref === undefined
    ? 'its source names no ref, so builds fetch the default branch HEAD'
    : `'${ref}' is not a full commit SHA, so it may be a mutable ref (branch or tag)`;
  return `hook ${definition.hookId} is not pinned to an immutable ref: ${got}. `
    + 'Its source is fetched fresh on every run, so a poisoned commit executes under the hook role (threat model T5). '
    + 'Pin source.sourceVersion to a full 40-character commit SHA.';
}

const byHookId = (a: HookDefinition, b: HookDefinition): number => (a.hookId < b.hookId ? -1 : a.hookId > b.hookId ? 1 : 0);

function resolved(scope: ResolvedHook['scope'], hook: HookDefinition, revision: number): ResolvedHook {
  return {
    hookId: hook.hookId,
    scope,
    revision,
    sourceType: hook.source.type,
    sourceLocation: hook.source.location,
    sourceVersion: hook.source.sourceVersion ?? '',
    script: hook.script,
    timeoutMinutes: hook.timeoutMinutes,
  };
}

/**
 * Resolves the hooks of one event into the execution input (R-40, R-45):
 * `pre` is the global hooks then the application hooks, `post` the
 * application hooks then the global hooks, each scope in ascending `hookId`
 * (byte order). The application hooks are the cell's stamp; the global hooks
 * are the records read at accept time, each with the revision it had at that
 * read (an application hook has none: revision `0`). The workflow runs the
 * lists as given and never re-reads a hook (R-20).
 */
export function resolveHooks(
  event: HookEvent,
  applicationHooks: readonly HookDefinition[] | undefined,
  globalHooks: readonly GlobalHookRecord[],
): HookExecutionInput {
  const select = <T extends HookDefinition>(hooks: readonly T[], phase: HookPhase): T[] =>
    hooks.filter((hook) => hook.phase === phase && hook.events.includes(event)).sort(byHookId);
  const global = (phase: HookPhase) => select(globalHooks, phase).map((hook) => resolved('GLOBAL', hook, hook.revision));
  const application = (phase: HookPhase) => select(applicationHooks ?? [], phase).map((hook) => resolved('APPLICATION', hook, 0));
  return {
    event,
    pre: [...global('PRE'), ...application('PRE')],
    post: [...application('POST'), ...global('POST')],
  };
}
