// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { RequestLine } from './state';

/**
 * The joins `collect` makes between what the driver saw and what the hops
 * logged. They are pure so a unit test runs them; the log queries are in
 * `collect.ts`.
 *
 * Edge: the driver keeps each answer's `x-amz-cf-id` header. CloudFront's
 * standard log carries `x-edge-request-id`, the same value, so the join
 * needs no header of the driver's own and no change to the router, which
 * can log one value only (`cf.logCustomData`, ADR-0010).
 *
 * Cell: the demo cell logs one line per request it receives, `served` or
 * `refused`, so its counts by status are the origin's own count of the
 * requests that reached it.
 */

export interface EdgeRow {
  readonly id: string;
  readonly status: number;
  readonly resultType: string;
  /** `viewer-request-log-data`: the tenant the router logged, `-` or empty for none. */
  readonly tenant: string;
  readonly seconds: number;
}

export interface EdgeJoin {
  /** Request lines with an id. */
  readonly expected: number;
  readonly matched: number;
  readonly missing: number;
  readonly statusMismatches: readonly string[];
  readonly tenantMismatches: readonly string[];
  /** CloudFront's `time-taken` for the matched requests. */
  readonly edgeSeconds: readonly number[];
  /** Matched refusals the router made itself, and how many of them the edge log marks as function generated. */
  readonly routerRefusals: number;
  readonly generatedByFunction: number;
}

const dash = (t: string): string => (t === '' ? '-' : t);

export function joinEdge(lines: readonly RequestLine[], rows: ReadonlyMap<string, EdgeRow>): EdgeJoin {
  let expected = 0;
  let matched = 0;
  let routerRefusals = 0;
  let generatedByFunction = 0;
  const statusMismatches: string[] = [];
  const tenantMismatches: string[] = [];
  const edgeSeconds: number[] = [];
  for (const l of lines) {
    if (l.id === '') continue;
    expected += 1;
    const row = rows.get(l.id);
    if (row === undefined) continue;
    matched += 1;
    edgeSeconds.push(row.seconds);
    if (row.status !== l.status && statusMismatches.length < 10) statusMismatches.push(`${l.kind}: client ${l.status}, edge log ${row.status}`);
    // An empty expected tenant means the router logs nothing for this kind; compare the rest.
    if (l.edgeTenant !== '' && dash(row.tenant) !== l.edgeTenant && tenantMismatches.length < 10) {
      tenantMismatches.push(`${l.kind}: expected tenant ${l.edgeTenant}, edge log ${dash(row.tenant)}`);
    }
    if (l.reason?.startsWith('edge-') === true) {
      routerRefusals += 1;
      if (row.resultType === 'FunctionGeneratedResponse') generatedByFunction += 1;
    }
  }
  return { expected, matched, missing: expected - matched, statusMismatches, tenantMismatches, edgeSeconds, routerRefusals, generatedByFunction };
}

/** Status of the cell's refusal that each client-side reason stands for. */
export const CELL_STATUS: Readonly<Record<string, number>> = {
  'cell-forbidden': 403,
  'cell-unauthorized': 401,
  'cell-rate-limited': 429,
  'cell-unavailable': 503,
  'cell-not-found': 404,
};

/** Requests the client saw reach the cell: served ones and the cell's own refusals, by status. */
export function expectedAtCell(lines: readonly RequestLine[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const l of lines) {
    const status = l.reason === undefined ? (l.status === 200 ? 200 : undefined) : CELL_STATUS[l.reason];
    if (status === undefined) continue;
    out.set(status, (out.get(status) ?? 0) + 1);
  }
  return out;
}

/** Differences between the client's count and the cell log's count, by status; empty when they agree. */
export function compareCell(expected: ReadonlyMap<number, number>, logged: ReadonlyMap<number, number>): string[] {
  const out: string[] = [];
  for (const s of new Set([...expected.keys(), ...logged.keys()])) {
    const e = expected.get(s) ?? 0;
    const l = logged.get(s) ?? 0;
    if (e !== l) out.push(`status ${s}: the driver saw ${e} reach the cell, the cell logged ${l}`);
  }
  return out;
}
