// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The shared contract of vendor lifecycle hooks (spec §4.8, §5.5, §6.5, §8.3,
 * R-39 to R-46, ADR-044). Types and constants only: the API (validation,
 * stamping, resolution), the infrastructure (roles, projects' trust) and the
 * workflow (buildspecs, the start/poll/stop loop) each build against this
 * file and never against one another.
 *
 * The string values of {@link HookEvent}, {@link HookPhase}, {@link HookScope}
 * and {@link HookSourceType} are the values of the Smithy enums of the same
 * names; the model and this file MUST agree member for member.
 */

import type { HookRoleKind } from '../shared/fleet';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The events a hook can run around (§4.8): three per build, `CELL_*` for the cell build, `DEPLOYMENT_*` for the tenant build (§8.3). */
export const HOOK_EVENTS = [
  'CELL_CREATE',
  'CELL_UPDATE',
  'CELL_DELETE',
  'DEPLOYMENT_CREATE',
  'DEPLOYMENT_UPDATE',
  'DEPLOYMENT_DELETE',
] as const;
export type HookEvent = typeof HOOK_EVENTS[number];

/** The events of the cell build. */
export const CELL_HOOK_EVENTS: readonly HookEvent[] = ['CELL_CREATE', 'CELL_UPDATE', 'CELL_DELETE'];
/** The events of the tenant build. */
export const DEPLOYMENT_HOOK_EVENTS: readonly HookEvent[] = ['DEPLOYMENT_CREATE', 'DEPLOYMENT_UPDATE', 'DEPLOYMENT_DELETE'];

/** `PRE`: before the script. `POST`: after the script succeeded (§4.8, R-45). */
export const HOOK_PHASES = ['PRE', 'POST'] as const;
export type HookPhase = typeof HOOK_PHASES[number];

/**
 * `GLOBAL`: registered through `PutHook`, applies to every application, runs
 * in the global hook project under `<fleet>-global-hook`. `APPLICATION`:
 * part of one application's definition, runs in the application hook project
 * under `<fleet>-app-hook` (R-41).
 */
export const HOOK_SCOPES = ['GLOBAL', 'APPLICATION'] as const;
export type HookScope = typeof HOOK_SCOPES[number];

/** The hook project and role a scope runs in (R-41): global hooks only in the global project, application hooks only in the application project. */
export const HOOK_ROLE_KIND_BY_SCOPE: Readonly<Record<HookScope, HookRoleKind>> = {
  GLOBAL: 'global-hook',
  APPLICATION: 'app-hook',
};

/** A CodeBuild source type a hook source may name; the members of the Smithy `SourceType` enum (§4.8). */
export const HOOK_SOURCE_TYPES = [
  'CODECOMMIT',
  'GITHUB',
  'GITHUB_ENTERPRISE',
  'GITLAB',
  'GITLAB_SELF_MANAGED',
  'BITBUCKET',
  'S3',
] as const;
export type HookSourceType = typeof HOOK_SOURCE_TYPES[number];

// ---------------------------------------------------------------------------
// Charsets and limits (R-39, §4.1, §4.8). Every pattern admits no control
// character and no character JSON escapes, so a definition is as large in the
// execution input as it is raw (§8.1).
// ---------------------------------------------------------------------------

/** URL characters without `@`, so a location carries no userinfo (`https://user:token@host/` is a 400, R-39). */
const SOURCE_LOCATION_CLASS = String.raw`[A-Za-z0-9._~:/?#\[\]!$&'()*+,;=%-]`;
/** The characters of a git ref (`^`, `{`, `}` and `+` included), a commit SHA or an object version. */
const SOURCE_VERSION_CLASS = String.raw`[A-Za-z0-9._/^{}+-]`;
/** The characters of a script path. */
const SCRIPT_PATH_CLASS = String.raw`[A-Za-z0-9._/-]`;

/** `hookId`: `[a-z0-9-]{1,32}` (§4.8). It orders hooks within a scope (R-45). */
export const HOOK_ID_PATTERN = /^[a-z0-9-]{1,32}$/;
/** A hook source `location`: at most 1,024 characters (§4.8). */
export const HOOK_SOURCE_LOCATION_PATTERN = new RegExp(`^${SOURCE_LOCATION_CLASS}{1,1024}$`);
/** A hook source `sourceVersion`: at most 128 characters (§4.8). */
export const HOOK_SOURCE_VERSION_PATTERN = new RegExp(`^${SOURCE_VERSION_CLASS}{1,128}$`);
/** A hook `script` path: at most 256 characters (§4.8). */
export const HOOK_SCRIPT_PATH_PATTERN = new RegExp(`^${SCRIPT_PATH_CLASS}{1,256}$`);

/** The application's own `source.location`: the hook charset, at most 2,048 bytes (§4.1). */
export const APPLICATION_SOURCE_LOCATION_PATTERN = new RegExp(`^${SOURCE_LOCATION_CLASS}{1,2048}$`);
/** The application's own `source.sourceVersion`: the hook charset, at most 256 bytes (§4.1). */
export const APPLICATION_SOURCE_VERSION_PATTERN = new RegExp(`^${SOURCE_VERSION_CLASS}{1,256}$`);
/** An application's `cellScripts` / `tenantScripts` path: the hook script charset, at most 1,024 bytes (§4.1). */
export const APPLICATION_SCRIPT_PATH_PATTERN = new RegExp(`^${SCRIPT_PATH_CLASS}{1,1024}$`);

/** `timeoutMinutes` bounds: CodeBuild's `timeoutInMinutesOverride` minimum is 5 (§4.8). */
export const HOOK_TIMEOUT_MINUTES_MIN = 5;
export const HOOK_TIMEOUT_MINUTES_MAX = 30;
/** The timeout a definition without one gets; stored resolved, so a stamp and a record always carry it (§4.8). */
export const DEFAULT_HOOK_TIMEOUT_MINUTES = 10;

/** At most this many global hooks are registered (`hookCount`, R-39). */
export const MAX_GLOBAL_HOOKS = 5;
/** At most this many hooks in one application's list (R-39). */
export const MAX_APPLICATION_HOOKS = 5;

/** `PK` of every global hook item and of the counter (§4.8). */
export const HOOK_PARTITION_KEY = 'HOOK';
/** A global hook item's `SK` is `HOOK#<hookId>`; the list query is `begins_with` this (R-40). */
export const HOOK_SORT_KEY_PREFIX = 'HOOK#';
/** `SK` of the hook counter item that holds `hookCount` (§4.8). */
export const HOOK_COUNTER_SORT_KEY = 'META';

// ---------------------------------------------------------------------------
// Definitions and records
// ---------------------------------------------------------------------------

/** The `{type, location, sourceVersion?}` of a hook, the shape of an application's `source` (§4.8). */
export interface HookSource {
  readonly type: HookSourceType;
  readonly location: string;
  /** A ref that is not a full 40-character commit SHA is accepted with a logged warning naming the hook (ADR-020). */
  readonly sourceVersion?: string;
}

/**
 * One hook definition, the shape of `PutHook`'s input plus its id and of one
 * entry in `PutApplication`'s `hooks` (§4.8, R-39). Carries no secret: every
 * read operation returns it to operators and readers alike (R-39, N-12).
 */
export interface HookDefinition {
  readonly hookId: string;
  /** Non-empty, distinct. */
  readonly events: readonly HookEvent[];
  readonly phase: HookPhase;
  readonly source: HookSource;
  /** Path of the script in `source`. */
  readonly script: string;
  /** 5 to 30; the API stores {@link DEFAULT_HOOK_TIMEOUT_MINUTES} when the request sent none. */
  readonly timeoutMinutes: number;
}

/** A global hook as stored under `PK=HOOK`, `SK=HOOK#<hookId>` (§4.8). */
export interface GlobalHookRecord extends HookDefinition {
  /** 1 on create, incremented by every replace; never supplied (R-39). */
  readonly revision: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The hook counter, `PK=HOOK`, `SK=META`: the authoritative count of global
 * hooks, at most {@link MAX_GLOBAL_HOOKS} (P-6, R-39).
 */
export interface HookCounterRecord {
  readonly hookCount: number;
}

/**
 * An application hook as stamped on a cell at creation (R-40, P-4): the
 * application's hook list at that moment, immutable for the cell's lifetime
 * and the only source of the application hooks of every event of that cell
 * and of its deployments. Its scope is {@link HookScope} `APPLICATION` and it
 * has no revision.
 */
export type StampedApplicationHook = HookDefinition;

/**
 * One entry of `lastGlobalHooks` on a cell or a deployment (R-40): a global
 * hook that ran for the record's last event, in run order. Written only by
 * the workflow's terminal writes that leave the record in place (§8.2); empty
 * when none ran, and a hook a `PRE` failure kept from running is not listed.
 */
export interface LastGlobalHookEntry {
  readonly hookId: string;
  readonly phase: HookPhase;
  readonly revision: number;
  /** The ref the hook names; absent when its source names none. */
  readonly sourceVersion?: string;
  /**
   * The commit the build ran: the full SHA the final poll reported (a git
   * source, also when the hook names a branch). Absent for an S3 source.
   */
  readonly resolvedSourceVersion?: string;
}

/** How one hook run ended (R-40, R-46). */
export const HOOK_RUN_OUTCOMES = [
  /** The build succeeded. */
  'SUCCEEDED',
  /** The build did not succeed, or timed out (run, queued or the attempt's deadline). */
  'FAILED',
  /** The build could not start (refused for the whole window, or the start outcome is unknown). */
  'NOT_STARTED',
  /** A delete hook whose attempts all failed or whose budget ran out: logged, counted, and the delete went on (R-46). */
  'SKIPPED',
] as const;
export type HookRunOutcome = typeof HOOK_RUN_OUTCOMES[number];

/**
 * The per-run record of one hook occurrence (R-40, R-46): what the workflow
 * logs and what `statusReason` is built from. The workflow keeps it in state
 * only as far as §8.1 allows; the fields stay small.
 */
export interface HookRunRecord {
  readonly hookId: string;
  readonly scope: HookScope;
  readonly event: HookEvent;
  readonly phase: HookPhase;
  /** The revision the execution's snapshot held; `0` for an application hook. */
  readonly revision: number;
  /** The ref the hook names, '' when none. */
  readonly sourceVersion: string;
  /** The commit the final poll reported; absent for an S3 source, or when no build started. */
  readonly resolvedSourceVersion?: string;
  /** The hook build's id, absent when none started. */
  readonly buildId?: string;
  /** The attempt of the last build started (R-42 `ATTEMPT`). */
  readonly attempt: number;
  readonly outcome: HookRunOutcome;
  /** The kind and detail of a failure or skip; names the scope, the hook id and the build (R-46). */
  readonly statusReason?: string;
}

// ---------------------------------------------------------------------------
// Execution input (R-20, R-40, §8.1)
// ---------------------------------------------------------------------------

/**
 * One hook as the execution input carries it (R-20, R-40): the definition's
 * fields the workflow needs, flattened as the rest of the input is, and its
 * scope and revision. Always fully populated, so the workflow reads no absent
 * field: `sourceVersion` is '' when the source names none (as the input's own
 * `sourceVersion`), and `revision` is `0` for an application hook, which has
 * none. Under 1,600 bytes as compact JSON (§8.1).
 */
export interface ResolvedHook {
  readonly hookId: string;
  readonly scope: HookScope;
  readonly revision: number;
  readonly sourceType: HookSourceType;
  readonly sourceLocation: string;
  readonly sourceVersion: string;
  readonly script: string;
  readonly timeoutMinutes: number;
}

/**
 * The hooks of one event, resolved before the operation's first write (R-40)
 * and already in run order (R-45): `pre` holds global hooks, then application
 * hooks; `post` holds application hooks, then global hooks; within a scope in
 * ascending `hookId` (byte order). A hook with both phases cannot exist (a
 * definition has one `phase`), so each resolved hook is in exactly one list.
 * The workflow runs the lists as given and never re-reads a hook (R-20).
 *
 * It nests in the existing execution input as the `hooks` field of each
 * build phase: `ProvisioningWorkflowInput.cellBuild.hooks` for the cell event
 * and `ProvisioningWorkflowInput.tenantBuild.hooks` for the deployment event
 * (`BuildPhaseInput` in `tenant.ts`), always present, with empty lists when
 * no hook applies. A new-cell `CreateDeployment` therefore carries two:
 * the cell event's first (R-45).
 *
 * Nothing else crosses for R-42. `EXECUTION_ID` is the execution's own name,
 * read by the workflow from {@link EXECUTION_ID_CONTEXT_PATH}, and `ATTEMPT`
 * is workflow state (a delete hook's attempt counter, R-46). `EVENT` and
 * `PHASE` are {@link event} and the list a hook is in; `HOOK_ID`,
 * `HOOK_SCOPE` and `HOOK_SCRIPT` are the hook's own fields; `APPLICATION_ID`,
 * `CELL_ID`, `CELL_ACCOUNT_ID`, `TENANT_ID`, `TENANT_NAME`, `OPERATOR_ID` and
 * the parameter sets are the input fields the build phases already carry.
 */
export interface HookExecutionInput {
  /** The event this build serves: a `CELL_*` event on `cellBuild`, a `DEPLOYMENT_*` event on `tenantBuild` (R-42 `EVENT`). */
  readonly event: HookEvent;
  readonly pre: readonly ResolvedHook[];
  readonly post: readonly ResolvedHook[];
}

/** Where the workflow reads R-42 `EXECUTION_ID`: the execution name, one per accepted operation. */
export const EXECUTION_ID_CONTEXT_PATH = '$$.Execution.Name';

// ---------------------------------------------------------------------------
// Hook build environment (R-42)
// ---------------------------------------------------------------------------

/**
 * The fixed variables a hook build receives, no other control plane state
 * (R-42, H-5). Beside them: one `PARAM_<NAME>` per resolved parameter
 * ({@link HOOK_PARAM_ENV_PREFIX}).
 */
export const HOOK_ENV_VARS = [
  'EVENT',
  'PHASE',
  'HOOK_ID',
  'HOOK_SCOPE',
  'APPLICATION_ID',
  'CELL_ID',
  'CELL_ACCOUNT_ID',
  'TENANT_ID',
  'TENANT_NAME',
  'OPERATOR_ID',
  'EXECUTION_ID',
  'ATTEMPT',
  'HOOK_SCRIPT',
  'SCRIPT_OUTPUTS',
] as const;
export type HookEnvVar = typeof HOOK_ENV_VARS[number];

/** Present on deployment events only. */
export const HOOK_DEPLOYMENT_ONLY_ENV_VARS: readonly HookEnvVar[] = ['TENANT_ID', 'TENANT_NAME'];
/** Present on `POST` hooks only: the script's outputs, `{}` when it wrote none (R-43). */
export const HOOK_POST_ONLY_ENV_VARS: readonly HookEnvVar[] = ['SCRIPT_OUTPUTS'];
/** The prefix of a parameter variable, as for scripts (§6.1). */
export const HOOK_PARAM_ENV_PREFIX = 'PARAM_';
/**
 * Variables a hook build MUST NOT carry (R-41, R-42): onboarding input, the
 * account's external id, the pair's role ARNs and the provisioning build's
 * own variables.
 */
export const HOOK_FORBIDDEN_ENV_VARS = [
  'ADMIN_EMAIL',
  'OUTPUTS_FILE',
  'SCRIPT_PATH',
  'PROVISIONING_ROLE_ARN',
  'PROVISIONING_EXTERNAL_ID',
  'OPERATOR_SESSION_NAME',
] as const;

// ---------------------------------------------------------------------------
// Script outputs (R-43, §6.1)
// ---------------------------------------------------------------------------

/** The variable that gives a cell or tenant script the path it MAY write its outputs to (§6.1, R-43). */
export const OUTPUTS_FILE_ENV_VAR = 'OUTPUTS_FILE';
/** The one variable the provisioning build exports (R-43); hooks receive it as {@link HookEnvVar} `SCRIPT_OUTPUTS`. */
export const SCRIPT_OUTPUTS_EXPORT_NAME = 'SCRIPT_OUTPUTS';
/** The compact form's limit in bytes, measured on the re-serialisation (R-43); printable ASCII, so also characters. */
export const SCRIPT_OUTPUTS_MAX_BYTES = 4096;
/** An outputs key: `[A-Za-z][A-Za-z0-9_]{0,63}` (R-43). */
export const SCRIPT_OUTPUT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const OUTPUT_KEY_SOURCE = '[A-Za-z][A-Za-z0-9_]{0,63}';

/**
 * The workflow guard's format check on `SCRIPT_OUTPUTS`, exactly as R-43
 * states it, with the key pattern for `K`: only the compact spelling of an
 * object of printable-ASCII string values, linear in its input. It cannot
 * see a repeated key (R-43), and it does not check the length, which is
 * {@link SCRIPT_OUTPUTS_MAX_BYTES}. The workflow tests it in a JSONata
 * expression (never `$parse`); {@link SCRIPT_OUTPUT_GUARD_SOURCE} is the
 * pattern text for that.
 */
export const SCRIPT_OUTPUT_GUARD_SOURCE =
  String.raw`^\{(?:"${OUTPUT_KEY_SOURCE}":"(?:[ !#-\[\]-~]|\\["\\]|","${OUTPUT_KEY_SOURCE}":")*")?\}$`;
export const SCRIPT_OUTPUT_GUARD_PATTERN = new RegExp(SCRIPT_OUTPUT_GUARD_SOURCE);

// ---------------------------------------------------------------------------
// Workflow timing (R-46, §8.3), shared by the workflow and its tests
// ---------------------------------------------------------------------------

/** A hook build is polled with `batchGetBuilds` every 60 seconds. */
export const HOOK_POLL_INTERVAL_SECONDS = 60;
/** A refused start waits 30 seconds, without backoff, before the next try. */
export const HOOK_REFUSAL_WAIT_SECONDS = 30;
/** Refusals end the start once this many minutes have passed since the attempt's first try. */
export const HOOK_REFUSAL_WINDOW_MINUTES = 5;
/** A stop is polled to a final status within this many minutes (R-23). */
export const HOOK_STOP_BUDGET_MINUTES = 2;
/** A delete hook runs at most this many attempts, counting those that started a build (R-46). */
export const HOOK_DELETE_MAX_ATTEMPTS = 3;
/** A delete hook's backoff: 60 seconds after the first failure, then doubled (interval 60 s, rate 2). */
export const HOOK_DELETE_BACKOFF_SECONDS = 60;
export const HOOK_DELETE_BACKOFF_RATE = 2;
