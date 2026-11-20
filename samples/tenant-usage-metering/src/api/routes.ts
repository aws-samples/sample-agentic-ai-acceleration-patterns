// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Which caller may call which route (spec §3.2). One table serves the API's
 * resource policy (src/construct/api.ts) and the admin function's own check
 * of each operation (src/api/handler.ts), so the two cannot drift.
 */

export type CallerClass = 'registrar' | 'operator' | 'reader';

export interface Route {
  readonly operation: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** The resource path as API Gateway models it. */
  readonly path: string;
  readonly callers: ReadonlyArray<CallerClass>;
}

const OPERATOR: CallerClass[] = ['operator'];
const REGISTRAR: CallerClass[] = ['registrar'];
const USAGE_READ: CallerClass[] = ['operator', 'reader'];

export const ADMIN_ROUTES: ReadonlyArray<Route> = [
  { operation: 'CreateMeter', method: 'POST', path: '/meters', callers: OPERATOR },
  { operation: 'ListMeters', method: 'GET', path: '/meters', callers: OPERATOR },
  { operation: 'GetMeter', method: 'GET', path: '/meters/{meterId}', callers: OPERATOR },
  { operation: 'UpdateMeter', method: 'PATCH', path: '/meters/{meterId}', callers: OPERATOR },
  { operation: 'DeleteMeter', method: 'DELETE', path: '/meters/{meterId}', callers: OPERATOR },

  { operation: 'CreateSink', method: 'POST', path: '/sinks', callers: OPERATOR },
  { operation: 'ListSinks', method: 'GET', path: '/sinks', callers: OPERATOR },
  { operation: 'GetSink', method: 'GET', path: '/sinks/{sinkId}', callers: OPERATOR },
  { operation: 'UpdateSink', method: 'PATCH', path: '/sinks/{sinkId}', callers: OPERATOR },
  { operation: 'DeleteSink', method: 'DELETE', path: '/sinks/{sinkId}', callers: OPERATOR },

  { operation: 'PutEmitter', method: 'PUT', path: '/emitters/{emitterId}', callers: REGISTRAR },
  { operation: 'DeleteEmitter', method: 'DELETE', path: '/emitters/{emitterId}', callers: REGISTRAR },
  { operation: 'GetEmitter', method: 'GET', path: '/emitters/{emitterId}', callers: OPERATOR },
  { operation: 'ListEmitters', method: 'GET', path: '/emitters', callers: OPERATOR },
  { operation: 'PutTenantBinding', method: 'PUT', path: '/emitters/{emitterId}/tenants/{tenantId}', callers: REGISTRAR },
  { operation: 'DeleteTenantBinding', method: 'DELETE', path: '/emitters/{emitterId}/tenants/{tenantId}', callers: REGISTRAR },
  { operation: 'GetTenantBinding', method: 'GET', path: '/emitters/{emitterId}/tenants/{tenantId}', callers: OPERATOR },
  { operation: 'ListTenantBindings', method: 'GET', path: '/emitters/{emitterId}/tenants', callers: OPERATOR },

  { operation: 'GetUsage', method: 'GET', path: '/tenants/{tenantId}/applications/{applicationId}/meters/{meterId}/usage', callers: USAGE_READ },
  { operation: 'ListUsage', method: 'GET', path: '/tenants/{tenantId}/applications/{applicationId}/usage', callers: USAGE_READ },

  { operation: 'GetHour', method: 'GET', path: '/hours/{hour}', callers: OPERATOR },
  { operation: 'ListHours', method: 'GET', path: '/hours', callers: OPERATOR },

  { operation: 'StartRecount', method: 'POST', path: '/jobs/recount', callers: OPERATOR },
  { operation: 'StartReadmission', method: 'POST', path: '/jobs/readmission', callers: OPERATOR },
  { operation: 'StartIngestRedrive', method: 'POST', path: '/jobs/ingest-redrive', callers: OPERATOR },
  { operation: 'StartSinkRedrive', method: 'POST', path: '/jobs/sink-redrive', callers: OPERATOR },
  { operation: 'StartResendBlocked', method: 'POST', path: '/jobs/resend-blocked', callers: OPERATOR },
  { operation: 'GetJob', method: 'GET', path: '/jobs/{jobId}', callers: OPERATOR },
  { operation: 'ListJobs', method: 'GET', path: '/jobs', callers: OPERATOR },
];

export const INGEST_ROUTE: Route = { operation: 'PutUsageEvents', method: 'POST', path: '/usage-events', callers: [] };

export function callersOf(operation: string): ReadonlyArray<CallerClass> {
  return ADMIN_ROUTES.find((route) => route.operation === operation)?.callers ?? [];
}

/** The `execute-api` resource path of a route, labels as `*`. A `*` there
 * also matches `/`, so a route's path covers its sub-routes; routes of
 * different callers must never overlap (test/pure.test.ts). */
export function policyPath(route: Route): string {
  return `${route.method}${route.path.replace(/\{[^}]+\}/g, '*')}`;
}
