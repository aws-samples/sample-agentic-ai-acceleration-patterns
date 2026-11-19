// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `TenantUsageMetering`: the published construct (spec §6.3). One stack in
 * the metering account: the API, the table, the raw and export buckets, the
 * ingest pipeline, the recounter and the sinks (spec §3.1).
 */

import { Aws, Names } from 'aws-cdk-lib';
import type * as apigateway from 'aws-cdk-lib/aws-apigateway';
import type * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { ADMIN_ROUTES, INGEST_ROUTE } from './api/routes';
import { createAlarms } from './construct/alarms';
import { createApi, STAGE_NAME } from './construct/api';
import { type Compute, createCompute } from './construct/compute';
import { createPipeline, type Pipeline, shareBuses } from './construct/pipeline';
import { resolveProps, type ResolvedProps, type TenantUsageMeteringProps } from './construct/props';
import { createServiceRoles, type ServiceRoles, tableWriters } from './construct/roles';
import { createShareGuard, SHARE_GUARD_PROVIDER_ID } from './construct/share-guard';
import { createStorage, denyConfigurationChanges } from './construct/storage';
import { createTable } from './construct/table';
import { emitterRolePattern } from './shared/identity';
import { DEFAULT_NAMESPACE } from './shared/metrics';
import { acknowledgeWildcards } from './shared/nag';

export class TenantUsageMetering extends Construct {
  /** The props with every default applied. */
  public readonly config: ResolvedProps;
  public readonly table: dynamodb.TableV2;
  public readonly rawBucket: s3.Bucket;
  public readonly exportBucket: s3.Bucket;
  public readonly roles: ServiceRoles;
  /**
   * The sink dispatcher's role. For an `AWS_IAM` HTTP sink the deployer
   * grants this role invoke on the billing endpoint (a function URL or an
   * API Gateway route), and across accounts names it in the endpoint's
   * resource policy (ADR-0007).
   */
  public readonly dispatcherRole: iam.IRole;
  public readonly pipeline: Pipeline;
  public readonly compute: Compute;
  public readonly api: apigateway.RestApi;
  public readonly alarms: cloudwatch.Alarm[];
  /** The API's base URL, `https://.../v1/`. */
  public readonly apiUrl: string;
  /** The ingest bus ARN; undefined with `ingestPath: DIRECT`. */
  public readonly ingestBusArn?: string;
  public readonly usageBusArn: string;
  /** The `aws:PrincipalArn` pattern of emitter roles (spec §3.2). */
  public readonly emitterRoleNamePattern: string;
  /** What an emitter role in a cell account needs: `POST /usage-events` (spec §6.1). */
  public readonly ingestStatement: iam.PolicyStatement;
  /** What `<fleet>-global-hook` needs: the four registration routes (spec §6.1). */
  public readonly registrarStatement: iam.PolicyStatement;

  constructor(scope: Construct, id: string, props: TenantUsageMeteringProps) {
    super(scope, id);
    // Server access logs are written under a bucket policy, so the log
    // bucket keeps ACLs disabled. Set on this node (before any child exists)
    // so the construct does not depend on the consumer's cdk.json.
    this.node.setContext('@aws-cdk/aws-s3:serverAccessLogsUseBucketPolicy', true);
    this.config = resolveProps(props);

    // Physical names the trust conditions and policies need before the
    // resources exist; unique per stack and construct, within service limits.
    const unique = Names.uniqueResourceName(this, { maxLength: 40, separator: '-' }).toLowerCase();
    const names = {
      firehoseStreamName: `${unique}-raw`,
      ingestBusName: `${unique}-ingest`,
      usageBusName: `${unique}-usage`,
      ingestSubscriberName: `${unique}-ingest-to-firehose`,
      ingestShareName: `${unique}-ingest-share`,
      usageShareName: `${unique}-usage-share`,
      scheduleGroupName: unique,
    };
    const namespace = `${DEFAULT_NAMESPACE}/${unique}`;

    this.roles = createServiceRoles(this, names);
    this.dispatcherRole = this.roles.dispatcher;
    this.table = createTable(this, tableWriters(this.roles));
    const storage = createStorage(this, this.config, this.roles);
    this.rawBucket = storage.rawBucket;
    this.exportBucket = storage.exportBucket;
    this.pipeline = createPipeline(this, this.config, this.roles, this.rawBucket, names);
    this.ingestBusArn = this.pipeline.ingestBusArn;
    this.usageBusArn = this.pipeline.usageBusArn;
    // The AWS RAM shares and, before them, the registry check (ADR-0006).
    const sharedAccounts = [...this.config.rawSubscriberAccountIds, ...this.config.usageSubscriberAccountIds];
    if (sharedAccounts.length > 0) {
      const guard = createShareGuard(this, this.table, sharedAccounts);
      shareBuses(this, this.config, this.pipeline, names, guard);
    }
    this.emitterRoleNamePattern = emitterRolePattern(this.config.fleetName, Aws.PARTITION);

    this.compute = createCompute(this, {
      config: this.config,
      roles: this.roles,
      table: this.table,
      rawBucket: this.rawBucket,
      exportBucket: this.exportBucket,
      pipeline: this.pipeline,
      firehoseStreamName: names.firehoseStreamName,
      scheduleGroupName: names.scheduleGroupName,
      metricNamespace: namespace,
    });
    denyConfigurationChanges(this, storage);

    const api = createApi(this, {
      name: `${unique}-api`,
      ingestFn: this.compute.ingestFn,
      adminFn: this.compute.adminFn,
      emitterRolePattern: this.emitterRoleNamePattern,
      callers: {
        registrar: this.config.registrarPrincipalArns,
        operator: this.config.operatorPrincipalArns,
        reader: this.config.readerPrincipalArns,
      },
      logRetentionDays: this.config.rawRetentionDays,
    });
    this.api = api.api;
    this.apiUrl = this.api.url;

    this.ingestStatement = new iam.PolicyStatement({
      actions: ['execute-api:Invoke'],
      resources: [this.api.arnForExecuteApi(INGEST_ROUTE.method, INGEST_ROUTE.path, STAGE_NAME)],
    });
    this.registrarStatement = new iam.PolicyStatement({
      actions: ['execute-api:Invoke'],
      resources: ADMIN_ROUTES.filter((route) => route.callers.includes('registrar')).map((route) =>
        this.api.arnForExecuteApi(route.method, route.path.replace(/\{[^}]+\}/g, '*'), STAGE_NAME),
      ),
    });

    this.alarms = createAlarms(this, {
      compute: this.compute,
      pipeline: this.pipeline,
      namespace,
      alarmTopicArn: this.config.alarmTopicArn,
    });

    acknowledgeWildcards(this, (path) => {
      if (path.includes(`/${SHARE_GUARD_PROVIDER_ID}/`)) {
        return 'The custom-resource provider framework invokes the share guard function and its versions (`<arn>:*`); CDK owns the framework (ADR-0006).';
      }
      if (path.includes('/FirehoseRole/')) {
        return 'Firehose writes objects under the raw/ and firehose-error/ prefixes it names at run time (hour partitions, error types); grantPut adds the multipart actions it needs (spec §3.5).';
      }
      if (path.includes('/Role/') || path.includes('Role/DefaultPolicy')) {
        return "Grants scoped to this stack's table and its indexes, one bucket prefix, or one secret prefix; the item keys, object keys and secret names are chosen at run time (spec §3.5).";
      }
      return undefined;
    });
  }
}
