// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Context separation: two concerns, two objects.
 *
 * - `ServiceConfig` — static infrastructure configuration, the same for every
 *   request. Initialised once at Lambda cold start and passed to the service
 *   implementation's constructor.
 * - `CallerContext` — per-request caller identity, resolved by the ingress
 *   layer (the Lambda Authorizer) and passed to every operation. The logic
 *   layer never decodes JWTs or sees the raw event.
 *
 * Control plane callers are vendor operators acting across tenants, so the
 * context carries operator identity rather than a caller tenant scope
 * (see adr/0006-control-plane-data-not-tenant-scoped.md, ADR-006).
 */

import type { Grant } from './authorizer-policy';

/** Static service configuration — initialised once per Lambda cold start. */
export interface ServiceConfig {}

/**
 * Per-request caller context — resolved at the ingress layer from the
 * verified vendor IdP JWT. Immutable: the logic layer cannot modify it.
 */
export interface CallerContext {
  /** The vendor operator's identity (`sub` claim of the vendor IdP JWT). */
  readonly operatorId: string;
  /**
   * The caller's role claim as the vendor IdP issued it, for audit. The
   * authorizer admits no token without one, but the handler never defaults
   * it either.
   */
  readonly role?: string;
  /**
   * The grant the authorizer mapped the role to (spec R-36): `operator` holds
   * every operation, `reader` the `GET` operations only. The service checks
   * it again on every non-`GET` operation (`src/shared/grant-check.ts`).
   */
  readonly grant: Grant;
}

/**
 * The provisioning source fields relevant to supply-chain pinning
 * (threat model T5, mitigation M10). `sourceVersion` maps to the CodeBuild
 * StartBuild `sourceVersion` parameter; a full commit SHA is the only
 * immutable git ref — branches and tags can be moved by anyone with write
 * access to the repository.
 */
export interface PinnableSource {
  /** Source location, e.g. a git clone URL. */
  readonly location?: string;
  /** Optional git ref; a full 40-character commit SHA pins the source immutably. */
  readonly sourceVersion?: string;
}

/** Matches a full 40-character hex git commit SHA — the only immutable git ref. */
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i;

/** True when the ref is a full 40-character commit SHA (immutable). */
export function isFullCommitSha(ref: unknown): boolean {
  return typeof ref === 'string' && FULL_COMMIT_SHA.test(ref);
}

/**
 * Supply-chain check on an application's provisioning source, run by
 * `PutApplication` (threat model T5, mitigation M10, ADR-020, ADR-032):
 * CodeBuild fetches the source fresh on every lifecycle build, so anything
 * other than a full commit SHA lets a poisoned commit on a mutable ref
 * execute under the fleet roles.
 *
 * Returns a warning message when the source is not pinned to a full commit
 * SHA, and `undefined` when it is. Warn-and-allow by design — this is a
 * sample, and mutable refs are legitimate during development. Kept CDK-free
 * because it runs inside the Lambda handler.
 */
export function sourcePinningWarning(source: PinnableSource | undefined): string | undefined {
  const ref = source?.sourceVersion;
  if (isFullCommitSha(ref)) {
    return undefined;
  }
  const got = typeof ref === 'string' && ref.trim() !== ''
    ? `'${ref}' is a mutable ref (branch or tag)`
    : 'source.sourceVersion is not set, so builds fetch the default branch HEAD';
  return (
    `The application's provisioning source is not pinned to an immutable ref: ${got}. `
    + 'CodeBuild fetches the source fresh on every lifecycle build, so a poisoned commit '
    + 'executes under the fleet roles (threat model T5). Pin source.sourceVersion to a full '
    + '40-character commit SHA (mitigation M10).'
  );
}

/**
 * Reads a required environment variable, failing fast at cold start when the
 * infrastructure wiring is incomplete. A missing variable is a deployment
 * bug, never a client error.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
