// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Lambda entry of the run_code tool (spec §4.1, §5.1).
 *
 * Placeholder from the scaffold so the handler tree and its tests have a
 * real entry (ADR-0023). The owning worker replaces the body; the file
 * path is fixed by HANDLERS in src/handler-entry.ts.
 */

export async function handler(_event: unknown): Promise<never> {
  throw new Error('not built yet');
}
