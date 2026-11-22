// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The admin function: every route but `POST /usage-events` (spec §3.1).
 *
 * The API's resource policy already admits each route only to its callers
 * (spec §3.2); the function checks the same table again on the verified
 * caller ARN (src/api/routes.ts), so a misrouted method or a looser policy
 * still cannot run a registration as an operator or the reverse.
 */

import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { convertEvent, convertVersion1Response } from '@smithy/server-apigateway';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import type { AdminConfig, AdminContext, AdminDeps } from './deps';
import { apiError, isModelledError } from './errors';
import { errorResponse, lowercaseHeaders } from './http';
import { getJob, jobOut, listJobs, startIngestRedrive, startReadmission, startRecount, startResendBlocked, startSinkRedrive } from './jobs';
import { createMeter, deleteMeter, getMeter, listMeters, meterOut, updateMeter } from './meters';
import { getHour, listHours, readUsage, recordOut } from './reads';
import {
  bindingOut,
  deleteEmitter,
  deleteTenantBinding,
  emitterOut,
  getEmitter,
  getTenantBinding,
  listEmitters,
  listTenantBindings,
  putEmitter,
  putTenantBinding,
} from './registry';
import { type CallerClass, callersOf } from './routes';
import { createSink, deleteSink, getSink, listSinks, sinkOut, updateSink } from './sinks';
import type { SumRule } from '../recount/rule';
import { documentClient } from '../shared/db';
import { ENV, listEnv, requireEnv, requireIntEnv } from '../shared/env';
import { callerIsListed, roleFromCallerArn } from '../shared/identity';
import type { JobItem } from '../shared/items';
import { errorName, log } from '../shared/logger';
import {
  getTenantUsageMeteringServiceServiceHandler,
  type TenantUsageMeteringServiceService,
} from '../smithy/metering/typescript-ssdk-codegen/src/server';

export interface CallerLists {
  readonly registrar: ReadonlyArray<string>;
  readonly operator: ReadonlyArray<string>;
  readonly reader: ReadonlyArray<string>;
}

/** Throws 403 unless the caller is listed for one of the operation's caller classes. */
export function authorise(operation: string, ctx: AdminContext, lists: CallerLists): void {
  const classes: ReadonlyArray<CallerClass> = callersOf(operation);
  if (!classes.some((cls) => callerIsListed(ctx.caller, lists[cls]))) {
    throw apiError.accessDenied();
  }
}

/** Runs an operation after the caller check; an unmodelled error is logged by type only. */
async function guarded<T>(operation: string, ctx: AdminContext, lists: CallerLists, run: () => Promise<T>): Promise<T> {
  authorise(operation, ctx, lists);
  try {
    return await run();
  } catch (error) {
    if (!isModelledError(error)) {
      log.error('operation failed', { operation, requestId: ctx.requestId, errorType: errorName(error) });
    }
    throw error;
  }
}

export function createAdminService(deps: AdminDeps, lists: CallerLists): TenantUsageMeteringServiceService<AdminContext> {
  const g = <T>(operation: string, ctx: AdminContext, run: () => Promise<T>) => guarded(operation, ctx, lists, run);
  return {
    PutUsageEvents: async (_input, ctx) =>
      g('PutUsageEvents', ctx, async () => {
        throw apiError.accessDenied();
      }),

    CreateMeter: async (input, ctx) =>
      g('CreateMeter', ctx, async () => ({
        meter: meterOut(
          await createMeter(deps, ctx, {
            meterId: input.meterId!,
            unit: input.unit!,
            rule: input.rule as SumRule,
            allowedApplications: input.allowedApplications,
            effectiveFrom: input.effectiveFrom,
          }),
        ),
      })),
    GetMeter: async (input, ctx) =>
      g('GetMeter', ctx, async () => {
        const out = await getMeter(deps, input.meterId!, input.versions === 'ALL');
        return { meter: meterOut(out.meter), versions: out.versions?.map(meterOut) };
      }),
    UpdateMeter: async (input, ctx) =>
      g('UpdateMeter', ctx, async () => ({
        meter: meterOut(
          await updateMeter(deps, ctx, {
            meterId: input.meterId!,
            unit: input.unit,
            rule: input.rule as SumRule | undefined,
            allowedApplications: input.allowedApplications,
          }),
        ),
      })),
    DeleteMeter: async (input, ctx) =>
      g('DeleteMeter', ctx, async () => ({ meter: meterOut(await deleteMeter(deps, ctx, input.meterId!)) })),
    ListMeters: async (input, ctx) =>
      g('ListMeters', ctx, async () => {
        const out = await listMeters(deps, input.nextToken, input.maxResults);
        return { meters: out.meters.map(meterOut), nextToken: out.nextToken };
      }),

    CreateSink: async (input, ctx) =>
      g('CreateSink', ctx, async () => ({
        sink: sinkOut(
          await createSink(deps, ctx, {
            sinkId: input.sinkId!,
            type: input.type!,
            enabled: input.enabled!,
            endpoint: input.endpoint!,
            auth: input.auth,
            secretName: input.secretName,
            mapping: input.mapping,
            meters: input.meters,
          }),
        ),
      })),
    GetSink: async (input, ctx) => g('GetSink', ctx, async () => ({ sink: sinkOut(await getSink(deps, input.sinkId!)) })),
    UpdateSink: async (input, ctx) =>
      g('UpdateSink', ctx, async () => ({
        sink: sinkOut(
          await updateSink(deps, {
            sinkId: input.sinkId!,
            enabled: input.enabled,
            endpoint: input.endpoint,
            secretName: input.secretName,
            mapping: input.mapping,
            meters: input.meters,
          }),
        ),
      })),
    DeleteSink: async (input, ctx) =>
      g('DeleteSink', ctx, async () => {
        await deleteSink(deps, input.sinkId!);
        return {};
      }),
    ListSinks: async (input, ctx) =>
      g('ListSinks', ctx, async () => {
        const out = await listSinks(deps, input.nextToken, input.maxResults);
        return { sinks: out.sinks.map(sinkOut), nextToken: out.nextToken };
      }),

    PutEmitter: async (input, ctx) =>
      g('PutEmitter', ctx, async () => ({
        emitter: emitterOut(
          await putEmitter(deps, ctx, {
            emitterId: input.emitterId!,
            applicationId: input.applicationId!,
            accountId: input.accountId!,
            trace: { executionId: input.controlPlaneExecutionId, operatorId: input.controlPlaneOperatorId },
          }),
        ),
      })),
    GetEmitter: async (input, ctx) =>
      g('GetEmitter', ctx, async () => ({ emitter: emitterOut(await getEmitter(deps, input.emitterId!)) })),
    DeleteEmitter: async (input, ctx) =>
      g('DeleteEmitter', ctx, async () => {
        const emitter = await deleteEmitter(deps, input.emitterId!, {
          executionId: input.controlPlaneExecutionId,
          operatorId: input.controlPlaneOperatorId,
        });
        return { emitter: emitter === undefined ? undefined : emitterOut(emitter) };
      }),
    ListEmitters: async (input, ctx) =>
      g('ListEmitters', ctx, async () => {
        const out = await listEmitters(deps, input.nextToken, input.maxResults);
        return { emitters: out.emitters.map(emitterOut), nextToken: out.nextToken };
      }),

    PutTenantBinding: async (input, ctx) =>
      g('PutTenantBinding', ctx, async () => {
        const out = await putTenantBinding(deps, ctx, {
          emitterId: input.emitterId!,
          tenantId: input.tenantId!,
          applicationId: input.applicationId!,
          billingAccount: input.billingAccount,
          trace: { executionId: input.controlPlaneExecutionId, operatorId: input.controlPlaneOperatorId },
        });
        return { binding: bindingOut(out.binding), resendJobId: out.resendJobId };
      }),
    GetTenantBinding: async (input, ctx) =>
      g('GetTenantBinding', ctx, async () => ({ binding: bindingOut(await getTenantBinding(deps, input.emitterId!, input.tenantId!)) })),
    DeleteTenantBinding: async (input, ctx) =>
      g('DeleteTenantBinding', ctx, async () => {
        const binding = await deleteTenantBinding(deps, input.emitterId!, input.tenantId!, {
          executionId: input.controlPlaneExecutionId,
          operatorId: input.controlPlaneOperatorId,
        });
        return { binding: binding === undefined ? undefined : bindingOut(binding) };
      }),
    ListTenantBindings: async (input, ctx) =>
      g('ListTenantBindings', ctx, async () => {
        const out = await listTenantBindings(deps, input.emitterId!, input.nextToken, input.maxResults);
        return { bindings: out.bindings.map(bindingOut), nextToken: out.nextToken };
      }),

    GetUsage: async (input, ctx) =>
      g('GetUsage', ctx, async () => {
        const out = await readUsage(deps, {
          tenantId: input.tenantId!,
          applicationId: input.applicationId!,
          meterId: input.meterId!,
          from: input.from!,
          to: input.to!,
          nextToken: input.nextToken,
          maxResults: input.maxResults,
        });
        return { records: out.records.map(recordOut), nextToken: out.nextToken };
      }),
    ListUsage: async (input, ctx) =>
      g('ListUsage', ctx, async () => {
        const out = await readUsage(deps, {
          tenantId: input.tenantId!,
          applicationId: input.applicationId!,
          from: input.from!,
          to: input.to!,
          nextToken: input.nextToken,
          maxResults: input.maxResults,
        });
        return { records: out.records.map(recordOut), nextToken: out.nextToken };
      }),

    GetHour: async (input, ctx) => g('GetHour', ctx, async () => ({ hourSummary: await getHour(deps, input.hour!) })),
    ListHours: async (input, ctx) => g('ListHours', ctx, async () => listHours(deps, input.nextToken, input.maxResults)),

    StartRecount: async (input, ctx) =>
      g('StartRecount', ctx, async () => ({ job: jobOut(await startRecount(deps, ctx, input.from!, input.to!)) })),
    StartReadmission: async (input, ctx) =>
      g('StartReadmission', ctx, async () => ({ job: jobOut(await startReadmission(deps, ctx, input.from!, input.to!, input.reason)) })),
    StartIngestRedrive: async (_input, ctx) =>
      g('StartIngestRedrive', ctx, async () => ({ job: jobOut(await startIngestRedrive(deps, ctx)) })),
    StartSinkRedrive: async (input, ctx) =>
      g('StartSinkRedrive', ctx, async () => ({ job: jobOut(await startSinkRedrive(deps, ctx, input.sinkId!, input.from, input.to)) })),
    StartResendBlocked: async (input, ctx) =>
      g('StartResendBlocked', ctx, async () => ({
        job: jobOut(await startResendBlocked(deps, ctx, input.tenantId!, input.applicationId!)),
      })),
    GetJob: async (input, ctx) => g('GetJob', ctx, async () => ({ job: jobOut(await getJob(deps, input.jobId!)) })),
    ListJobs: async (input, ctx) =>
      g('ListJobs', ctx, async () => {
        const out = await listJobs(deps, input.nextToken, input.maxResults);
        return { jobs: out.jobs.map(jobOut), nextToken: out.nextToken };
      }),
  };
}

export function createAdminHandler(service: TenantUsageMeteringServiceService<AdminContext>) {
  const serviceHandler = getTenantUsageMeteringServiceServiceHandler<AdminContext>(service);
  return async (event: APIGatewayProxyEvent, context?: Pick<Context, 'awsRequestId'>): Promise<APIGatewayProxyResult> => {
    const requestId = event.requestContext?.requestId ?? context?.awsRequestId ?? 'unknown';
    const caller = roleFromCallerArn(event.requestContext?.identity?.userArn);
    if (caller === undefined) {
      return errorResponse(403, 'AccessDeniedException', 'caller is not permitted for this route');
    }
    try {
      const response = convertVersion1Response(await serviceHandler.handle(convertEvent(lowercaseHeaders(event)), { caller, requestId }));
      if (response.statusCode >= 500) {
        log.error('admin request failed', { requestId, httpStatus: response.statusCode });
      }
      return response;
    } catch (error) {
      log.error('admin request failed', { requestId, errorType: errorName(error) });
      return errorResponse(500, 'InternalServerError', 'internal error');
    }
  };
}

/** The worker function of each job kind (spec §4.6). */
export function jobFunctionOf(kind: JobItem['kind']): string {
  switch (kind) {
    case 'READMIT':
      return requireEnv(ENV.readmissionFunction);
    case 'INGEST_REDRIVE':
      return requireEnv(ENV.redriveFunction);
    default:
      return requireEnv(ENV.jobsFunction);
  }
}

function fromEnv() {
  const lambda = new LambdaClient({});
  const config: AdminConfig = {
    tableName: requireEnv(ENV.tableName),
    fleetName: requireEnv(ENV.fleetName),
    recountWindowHours: requireIntEnv(ENV.recountWindowHours),
    closeGraceMinutes: requireIntEnv(ENV.closeGraceMinutes),
    blockedAccountIds: listEnv(ENV.blockedAccounts),
    ingestPath: requireEnv(ENV.ingestPath) === 'DIRECT' ? 'DIRECT' : 'BUS',
  };
  const deps: AdminDeps = {
    db: documentClient(),
    config,
    startJob: async (job) => {
      await lambda.send(
        new InvokeCommand({
          FunctionName: jobFunctionOf(job.kind),
          InvocationType: 'Event',
          Payload: Buffer.from(JSON.stringify({ jobId: job.jobId })),
        }),
      );
    },
  };
  const lists: CallerLists = {
    registrar: listEnv(ENV.registrarArns),
    operator: listEnv(ENV.operatorArns),
    reader: listEnv(ENV.readerArns),
  };
  return createAdminHandler(createAdminService(deps, lists));
}

let cached: ReturnType<typeof createAdminHandler> | undefined;

export const handler = (event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult> => {
  cached ??= fromEnv();
  return cached(event, context);
};
