// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The main stack (spec §3.1), in the control plane's Region: the
 * multi-tenant distribution and its pooled distribution tenant, the router
 * and its KeyValueStore, the response headers policy, the SPA bucket, the
 * registrar, the custom resource for the `app` and `signin` keys, the
 * route table alarm, the published parameter, and the dedicated-domain
 * guard and teardown, which exist in both states of `dedicatedDomains`.
 *
 * With `dedicatedDomains` on (§3.6) the registrar role also holds its
 * CloudFront and ACM actions, and the stack holds the sweeper, its table,
 * queue, schedules, log group and alarms, and the starter
 * (`dedicated-domains.cdk.ts`). The deploy order the switch needs (§3.4):
 * the teardown before the registrar function, so a stack delete removes the
 * registrar before the teardown runs; the registrar function before the
 * guard; the guard before both schedules; the sweeper before the starter.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Annotations, CfnOutput, CustomResource, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { buildContentSecurityPolicy, readCspHashes, REPORT_GROUP } from './csp';
import { DedicatedDomainsGuard, DedicatedDomainsTeardown, registrarDedicatedDomainsPolicy, Sweeper } from './dedicated-domains.cdk';
import { ResolvedInputs } from './inputs';
import { acknowledge, BASIC_EXECUTION_ROLE_FINDING, nagFindingResource } from './nag';
import { allowEmptyBody, patchIntegrations, readRegistrarOpenApi } from './openapi';
import {
  API_FORWARDED_HEADERS,
  EdgeParameter,
  PARAM_EDGE,
  REGISTRAR_ENV,
  SIGNIN_HOST_LABEL,
  substituteRouterTokens,
} from '../shared/contracts';
import {
  appEntry,
  encodeEntry,
  METRIC_DIMENSION_DISTRIBUTION,
  METRIC_NAMESPACE,
  METRIC_ROUTE_TABLE_BYTES,
  RESERVED_LABELS,
  STORE_ALARM_BYTES,
} from '../shared/route-table';

/** CloudFront Functions' limit on a function's code. */
export const MAX_ROUTER_BYTES = 10 * 1024;

/** The registrar's REST API stage. */
export const REGISTRAR_STAGE = 'v1';

/**
 * The stage throttle: the store takes about three writes a second, and a
 * burst of 100 creates should reach the registrar and queue on the ETag
 * (§3.4 step 5). Chosen, not measured.
 */
export const REGISTRAR_THROTTLE = { rateLimit: 10, burstLimit: 100 } as const;

/** The registrar function's timeout (§3.4: the guard's 40 s wait rests on it). */
export const REGISTRAR_TIMEOUT = Duration.seconds(30);

/**
 * The `/api/*` behaviour's origin before the router sets the tenant's cell
 * (§3.3 step 7). The router answers or replaces it on every request, so it
 * is never reached; it is a Lambda function URL host with a label that no
 * function URL can have (url ids are 32 characters), so a request that did
 * reach it would get Lambda's own refusal.
 */
export function unroutedCellOrigin(region: string): string {
  return `unrouted.lambda-url.${region}.on.aws`;
}

export interface MainStackProps extends StackProps {
  readonly inputs: ResolvedInputs;
  /** From the edge stack, in `us-east-1`. */
  readonly certificateArn: string;
  readonly webAclArn: string;
  /** The router's source, with the `ROUTER_TOKENS` literals (build slice S1). */
  readonly routerSourcePath: string;
  /** The registrar function's entry (build slice S3). */
  readonly registrarEntry: string;
}

export class MainStack extends Stack {
  public readonly distributionId: string;
  public readonly distributionArn: string;
  public readonly routeTableArn: string;
  public readonly registrarUrl: string;
  public readonly pooledTenantId: string;
  /** The connection group's routing endpoint: the CNAME target of the pooled host and of every dedicated domain. */
  public readonly routingEndpoint: string;

  constructor(scope: Construct, id: string, props: MainStackProps) {
    super(scope, id, props);
    const { inputs } = props;
    for (const warning of inputs.warnings) {
      Annotations.of(this).addWarningV2('tenant-front-door:input', warning);
    }

    // --- Route table and router (§3.3, §4.1, ADR-0003) -------------------
    const routeTable = new cloudfront.KeyValueStore(this, 'RouteTable', {
      comment: 'Tenant front door route table (spec §4.1)',
    });
    this.routeTableArn = routeTable.keyValueStoreArn;

    const router = new cloudfront.Function(this, 'Router', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(routerSource(props.routerSourcePath, inputs)),
      keyValueStore: routeTable,
      comment: 'Tenant front door router (spec §3.3)',
      autoPublish: true,
    });

    new RouteTableKeys(this, 'RouteTableKeys', { routeTable, inputs });

    // --- SPA bucket (§3.1, M-44) ------------------------------------------
    const spaBucket = new s3.Bucket(this, 'SpaBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY, // sample only
      autoDeleteObjects: true,
    });
    acknowledge(
      spaBucket,
      'AwsSolutions-S1',
      'Reads reach the bucket only through the distribution, whose standard logging v2 records every request (ADR-0010); '
      + 'writes are limited to the two deployment roles by the bucket policy and recorded by CloudTrail (M-44).',
    );
    const spaOac = new cloudfront.S3OriginAccessControl(this, 'SpaOriginAccessControl', {
      description: 'Tenant front door SPA bucket (spec §3.1)',
      signing: cloudfront.Signing.SIGV4_ALWAYS,
    });

    // --- Policies (§3.2, §7.1) ---------------------------------------------
    const csp = buildContentSecurityPolicy({
      hashes: readCspHashes(inputs.spaSource),
      tokenOrigin: inputs.issuer.token.origin,
      exchangeOrigin: inputs.issuer.exchange?.origin,
      authorizeOrigin: inputs.issuer.authorize.origin,
      signinOrigin: inputs.addressing === 'host' ? `https://${SIGNIN_HOST_LABEL}.${inputs.appDomain}` : undefined,
      reporting: inputs.reportingEndpoint !== undefined,
    });
    const responseHeaders = new cloudfront.ResponseHeadersPolicy(this, 'ResponseHeaders', {
      comment: 'Tenant front door header baseline (spec §7.1)',
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: csp, override: true },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.seconds(31_536_000),
          includeSubdomains: false,
          preload: false,
          override: true,
        },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        contentTypeOptions: { override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
      },
      customHeadersBehavior: {
        customHeaders: [
          { header: 'Cross-Origin-Opener-Policy', value: 'same-origin', override: true },
          { header: 'Cross-Origin-Resource-Policy', value: 'same-origin', override: true },
          { header: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()', override: true },
          ...(inputs.reportingEndpoint !== undefined
            ? [{ header: 'Reporting-Endpoints', value: `${REPORT_GROUP}="${inputs.reportingEndpoint}"`, override: true }]
            : []),
        ],
      },
    });

    // The SPA's own Cache-Control decides (§3.2): immutable under /assets/,
    // no-cache for the shell. No key part varies by tenant.
    const spaCache = new cloudfront.CachePolicy(this, 'SpaCache', {
      comment: 'Tenant front door SPA: origin Cache-Control, one entry for every tenant (spec §3.2)',
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.days(1),
      maxTtl: Duration.days(365),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });
    const apiRequests = new cloudfront.OriginRequestPolicy(this, 'ApiRequests', {
      comment: 'Tenant front door /api/*: exactly the three headers of spec §3.2',
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(...API_FORWARDED_HEADERS),
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
    });

    // --- Multi-tenant distribution (ADR-0002, spike S-1) --------------------
    const routerAssociation = [{ eventType: 'viewer-request', functionArn: router.functionArn }];
    const behaviour = (pathPattern: string, targetOriginId: string, extra: Record<string, unknown>) => ({
      pathPattern,
      targetOriginId,
      responseHeadersPolicyId: responseHeaders.responseHeadersPolicyId,
      functionAssociations: routerAssociation,
      compress: true,
      ...extra,
    });
    const spaBehaviour = {
      viewerProtocolPolicy: 'redirect-to-https',
      allowedMethods: ['GET', 'HEAD'],
      cachedMethods: ['GET', 'HEAD'],
      cachePolicyId: spaCache.cachePolicyId,
    };
    const dynamicBehaviour = {
      viewerProtocolPolicy: 'https-only',
      allowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'],
      cachedMethods: ['GET', 'HEAD'],
      cachePolicyId: cloudfront.CachePolicy.CACHING_DISABLED.cachePolicyId,
    };
    const httpsOrigin = { originProtocolPolicy: 'https-only', httpsPort: 443, originSslProtocols: ['TLSv1.2'] };

    const origins: cloudfront.CfnDistribution.OriginProperty[] = [
      {
        id: 'spa',
        domainName: spaBucket.bucketRegionalDomainName,
        s3OriginConfig: { originAccessIdentity: '' },
        originAccessControlId: spaOac.originAccessControlId,
      },
      { id: 'cell', domainName: unroutedCellOrigin(inputs.controlPlane.region), customOriginConfig: httpsOrigin },
    ];
    const cacheBehaviors = [
      behaviour('/assets/*', 'spa', spaBehaviour),
      behaviour('/api/*', 'cell', { ...dynamicBehaviour, originRequestPolicyId: apiRequests.originRequestPolicyId }),
    ];
    if (inputs.agentIngress !== undefined) {
      origins.push({
        id: 'agents',
        domainName: inputs.agentIngress.domainName,
        originPath: inputs.agentIngress.originPath,
        customOriginConfig: httpsOrigin,
      });
      cacheBehaviors.push(behaviour('/agents/*', 'agents', {
        ...dynamicBehaviour,
        originRequestPolicyId: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER.originRequestPolicyId,
      }));
    }
    const { pathPattern: _default, ...defaultCacheBehavior } = behaviour('*', 'spa', spaBehaviour);

    const distribution = new cloudfront.CfnDistribution(this, 'Distribution', {
      distributionConfig: {
        enabled: true,
        comment: `Tenant front door for ${inputs.appDomain}`,
        connectionMode: 'tenant-only',
        httpVersion: 'http2',
        origins,
        defaultCacheBehavior: defaultCacheBehavior as cloudfront.CfnDistribution.DefaultCacheBehaviorProperty,
        cacheBehaviors: cacheBehaviors as cloudfront.CfnDistribution.CacheBehaviorProperty[],
        // Distribution tenants inherit the certificate (ADR-0002).
        viewerCertificate: {
          acmCertificateArn: props.certificateArn,
          sslSupportMethod: 'sni-only',
          minimumProtocolVersion: 'TLSv1.2_2021',
        },
        webAclId: props.webAclArn,
      },
    });
    acknowledge(
      distribution,
      'AwsSolutions-CFR1',
      'Tenants are served worldwide; a distribution tenant can carry its own geographic restriction (spec §3.1, ADR-0002).',
    );
    acknowledge(
      distribution,
      'AwsSolutions-CFR3',
      'A multi-tenant distribution has no legacy logging. Standard logging v2 is the edge logging stack\'s delivery, '
      + 'with a closed field list (ADR-0010, M-21).',
    );
    this.distributionId = distribution.ref;
    this.distributionArn = this.formatArn({ service: 'cloudfront', region: '', resource: 'distribution', resourceName: distribution.ref });

    // OAC reads for this distribution only; writes by the two deployment
    // roles only (§3.1, M-44, ADR-0023).
    spaBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DistributionReads',
      principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
      actions: ['s3:GetObject'],
      resources: [spaBucket.arnForObjects('*')],
      conditions: { StringEquals: { 'AWS:SourceArn': this.distributionArn } },
    }));
    const deployments = deploySpa(this, spaBucket, inputs.spaSource);
    const writerRoleArns = [deployments.uploaderRoleArn, autoDeleteRoleArn(this)];
    spaBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DeploymentRolesOnlyWrite',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion'],
      resources: [spaBucket.arnForObjects('*')],
      conditions: { ArnNotEquals: { 'aws:PrincipalArn': writerRoleArns } },
    }));
    // ADR-0008 release order: the policy (with the new hashes) deploys
    // before the files that need them.
    for (const d of deployments.deployments) {
      d.node.addDependency(distribution, responseHeaders);
    }

    // --- Pooled distribution tenant and DNS (§3.1, spike S-1) ---------------
    const label = inputs.appDomain.replace(/\./g, '-');
    const connectionGroup = new cloudfront.CfnConnectionGroup(this, 'ConnectionGroup', {
      name: `tfd-${label}`.slice(0, 128),
      ipv6Enabled: true,
      enabled: true,
    });
    const pooledDomain = inputs.addressing === 'host' ? `*.${inputs.appDomain}` : inputs.appDomain;
    const pooled = new cloudfront.CfnDistributionTenant(this, 'PooledTenant', {
      name: `pooled-${label}`.slice(0, 128),
      distributionId: distribution.ref,
      connectionGroupId: connectionGroup.attrId,
      domains: [pooledDomain],
      enabled: true,
    });
    this.pooledTenantId = pooled.attrId;
    this.routingEndpoint = connectionGroup.attrRoutingEndpoint;
    // The tenant points its dedicated domain here with a CNAME (§3.4 step 5, §6.4).
    new CfnOutput(this, 'RoutingEndpoint', {
      description: 'CNAME target for a dedicated domain: the connection group\'s routing endpoint (spec §6.4)',
      value: connectionGroup.attrRoutingEndpoint,
    });
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: inputs.hostedZone.zoneId,
      zoneName: inputs.hostedZone.zoneName,
    });
    const record = new route53.CnameRecord(this, 'PooledRecord', {
      zone,
      recordName: `${pooledDomain}.`,
      domainName: connectionGroup.attrRoutingEndpoint,
      ttl: Duration.minutes(5),
    });
    record.node.addDependency(pooled);

    // --- Registrar (§3.4, §5.1) ---------------------------------------------
    const registrar = new Registrar(this, 'Registrar', {
      inputs,
      entry: props.registrarEntry,
      routeTableArn: routeTable.keyValueStoreArn,
      distributionId: distribution.ref,
      connectionGroupId: connectionGroup.attrId,
    });
    this.registrarUrl = registrar.url;

    // --- Dedicated domains (§3.4 step 5, §6.2, ADR-0018) ---------------------
    // On a stack delete the registrar goes first, so no dedicated
    // distribution tenant is created while the teardown runs; the teardown
    // then runs before the distribution's delete.
    const teardown = new DedicatedDomainsTeardown(this, 'DedicatedDomainsTeardown', {
      distributionId: distribution.ref,
      pooledTenantId: pooled.attrId,
    });
    // Dedicated distribution tenants sit in the connection group too, so it goes after the teardown.
    teardown.resource.node.addDependency(connectionGroup);
    (registrar.function.node.defaultChild as lambda.CfnFunction).node.addDependency(teardown.resource);
    const guard = new DedicatedDomainsGuard(this, 'DedicatedDomainsGuard', {
      dedicatedDomains: inputs.dedicatedDomains,
      routeTableArn: routeTable.keyValueStoreArn,
      distributionId: distribution.ref,
      pooledTenantId: pooled.attrId,
    });
    guard.resource.node.addDependency(registrar.function);

    const alarmAction = inputs.alarmTopicArn === undefined
      ? undefined
      : new cloudwatchActions.SnsAction(sns.Topic.fromTopicArn(this, 'AlarmTopic', inputs.alarmTopicArn));
    if (inputs.dedicatedDomains) {
      const sweeper = new Sweeper(this, 'Sweeper', {
        routeTableArn: routeTable.keyValueStoreArn,
        distributionId: distribution.ref,
        pooledTenantId: pooled.attrId,
        alarmAction,
      });
      for (const schedule of sweeper.schedules) schedule.node.addDependency(guard.resource);
    }

    // --- Route table alarm (§4.1, ADR-0012, M-43, M-48) ---------------------
    const alarm = new cloudwatch.Alarm(this, 'RouteTableBytesAlarm', {
      alarmDescription: 'The route table is at 80 % of the 5 MB KeyValueStore: plan a shard before creates fail with 507 (spec §4.1, ADR-0012)',
      metric: new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: METRIC_ROUTE_TABLE_BYTES,
        statistic: cloudwatch.Stats.MAXIMUM,
        period: Duration.minutes(5),
        dimensionsMap: { [METRIC_DIMENSION_DISTRIBUTION]: distribution.ref },
      }),
      threshold: STORE_ALARM_BYTES,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    if (alarmAction !== undefined) {
      alarm.addAlarmAction(alarmAction);
    }

    // --- Published parameter (§6.4) -----------------------------------------
    const published: EdgeParameter = {
      version: 1,
      appDomain: inputs.appDomain,
      addressing: inputs.addressing,
      applicationId: inputs.applicationId,
      distributionArn: this.distributionArn,
      registrarUrl: registrar.url,
      tenantClaim: inputs.tenantClaim,
      reservedLabels: RESERVED_LABELS,
    };
    new ssm.StringParameter(this, 'EdgeParameter', {
      parameterName: PARAM_EDGE,
      description: 'Tenant front door published interface (spec §6.4)',
      stringValue: this.toJsonString(published),
    });
  }
}

/** Reads the router and compiles the stack's values in (§3.3, `ROUTER_TOKENS`). */
export function routerSource(file: string, inputs: ResolvedInputs): string {
  if (!fs.existsSync(file)) {
    throw new Error(`The router source ${file} is missing (build slice S1 writes src/router/router.js)`);
  }
  const source = substituteRouterTokens(fs.readFileSync(file, 'utf8'), {
    appDomain: inputs.appDomain,
    addressing: inputs.addressing,
    tenantClaim: inputs.tenantClaim,
    agentIngress: inputs.agentIngress !== undefined ? 'on' : 'off',
    reservedLabels: RESERVED_LABELS.join(','),
  });
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > MAX_ROUTER_BYTES) {
    throw new Error(`The router is ${bytes} bytes, over CloudFront Functions' ${MAX_ROUTER_BYTES}`);
  }
  return source;
}

/**
 * Two deployments of `spaSource`: `/assets/*` immutable for a year, the
 * rest `no-cache` (§3.2). Neither prunes, so the previous release's chunks
 * stay for the pages that still load them (ADR-0008 release order).
 * `csp.json` is a build input, not a file the SPA serves.
 */
function deploySpa(scope: Construct, bucket: s3.Bucket, spaSource: string) {
  const deployments: s3deploy.BucketDeployment[] = [];
  const sources: s3assets.Asset[] = [];
  const deploy = (id: string, sourcePath: string, exclude: string[], keyPrefix: string | undefined, cacheControl: s3deploy.CacheControl) => {
    const asset = new s3assets.Asset(scope, `${id}Source`, { path: sourcePath, exclude });
    sources.push(asset);
    deployments.push(new s3deploy.BucketDeployment(scope, id, {
      destinationBucket: bucket,
      destinationKeyPrefix: keyPrefix,
      sources: [s3deploy.Source.bucket(asset.bucket, asset.s3ObjectKey)],
      cacheControl: [cacheControl],
      prune: false,
      memoryLimit: 256,
    }));
  };
  const assets = path.join(spaSource, 'assets');
  if (fs.existsSync(assets)) {
    deploy('SpaAssets', assets, [], 'assets/', s3deploy.CacheControl.fromString('public, max-age=31536000, immutable'));
  }
  deploy('SpaShell', spaSource, ['assets', 'assets/**', 'csp.json'], undefined, s3deploy.CacheControl.noCache());

  // Both deployments share CDK's one singleton handler, so one role uploads.
  const handler = Stack.of(scope).node.children.find((c) => c.node.id.startsWith('Custom::CDKBucketDeployment'));
  if (handler === undefined) {
    throw new Error('The BucketDeployment handler was not found');
  }
  const reason = 'CDK\'s BucketDeployment handler runs only at deploy and copies the build from the CDK asset bucket into the SPA bucket; '
    + 'its role is one of the two the bucket policy lets write (M-44, ADR-0023).';
  acknowledge(handler, BASIC_EXECUTION_ROLE_FINDING, reason);
  acknowledge(handler, 'AwsSolutions-L1', `${reason} CDK pins the handler's runtime.`);
  const wildcards = [
    ...['s3:GetObject*', 's3:GetBucket*', 's3:List*', 's3:DeleteObject*', 's3:Abort*'].map((a) => `Action::${a}`),
    `Resource::${nagFindingResource(scope, bucket.arnForObjects('*'))}`,
    ...sources.map((a) => `Resource::${nagFindingResource(scope, a.bucket.arnForObjects('*'))}`),
  ];
  for (const finding of new Set(wildcards)) {
    acknowledge(handler, `AwsSolutions-IAM5[${finding}]`, `${reason} CDK grants these on the asset bucket and the SPA bucket only.`);
  }
  return { deployments, uploaderRoleArn: deployments[0].handlerRole.roleArn };
}

/** The role of the stack's `autoDeleteObjects` provider, the one that empties the bucket at teardown. */
function autoDeleteRoleArn(stack: Stack): string {
  const provider = stack.node.tryFindChild('Custom::S3AutoDeleteObjectsCustomResourceProvider') as { roleArn?: string } | undefined;
  if (provider?.roleArn === undefined) {
    throw new Error('The S3 auto-delete provider was not found; the bucket policy cannot name the teardown role');
  }
  return provider.roleArn;
}

interface RouteTableKeysProps {
  readonly routeTable: cloudfront.KeyValueStore;
  readonly inputs: ResolvedInputs;
}

/** The custom resource that writes `app` and, in `host` mode, `signin` (§4.1, ADR-0016, M-20). */
class RouteTableKeys extends Construct {
  constructor(scope: Construct, id: string, props: RouteTableKeysProps) {
    super(scope, id);
    const { issuer } = props.inputs;
    const app = encodeEntry(appEntry({
      az: issuer.authorize.url,
      tk: issuer.token.url,
      cid: issuer.clientId,
      sc: issuer.scopes,
      lo: issuer.logout.url,
      ex: issuer.exchange?.url,
    }));

    const fn = new NodejsFunction(this, 'Function', {
      entry: path.join(__dirname, '..', 'custom-resources', 'route-table-keys.function.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.minutes(2),
      logGroup: new logs.LogGroup(this, 'Logs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY, // sample only
      }),
      loggingFormat: lambda.LoggingFormat.JSON,
      systemLogLevelV2: lambda.SystemLogLevel.WARN,
      applicationLogLevelV2: lambda.ApplicationLogLevel.WARN,
      description: 'Tenant front door: writes the route table\'s app and signin keys (spec §4.1)',
      bundling: { minify: true, sourceMap: false, externalModules: [] },
    });
    // The store's data plane takes only these; UpdateKeys writes both keys under one ETag.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cloudfront-keyvaluestore:DescribeKeyValueStore',
        'cloudfront-keyvaluestore:GetKey',
        'cloudfront-keyvaluestore:UpdateKeys',
      ],
      resources: [props.routeTable.keyValueStoreArn],
    }));
    acknowledge(fn, BASIC_EXECUTION_ROLE_FINDING, 'Logs-only managed policy NodejsFunction attaches; a scoped copy changes no access (M-36).');
    acknowledge(fn, 'AwsSolutions-L1', 'Node.js 24, the runtime the demo cell API uses too, so the sample runs on one runtime; move both when Node.js 26 is GA.');

    // A plain CustomResource the function answers itself (cfn-response.ts):
    // no provider framework, so no second function and no logged response.
    new CustomResource(this, 'Resource', {
      serviceToken: fn.functionArn,
      resourceType: 'Custom::TenantFrontDoorRouteTableKeys',
      properties: {
        KeyValueStoreArn: props.routeTable.keyValueStoreArn,
        App: app,
        ...(props.inputs.signinKeys !== undefined
          ? { SigninIds: props.inputs.signinKeys.ids, SigninCurrent: props.inputs.signinKeys.current }
          : {}),
      },
    });
  }
}

interface RegistrarProps {
  readonly inputs: ResolvedInputs;
  readonly entry: string;
  readonly routeTableArn: string;
  readonly distributionId: string;
  /** The connection group dedicated distribution tenants join (§3.4 step 5). */
  readonly connectionGroupId: string;
}

/**
 * The registrar (§3.4, §5.1): a regional REST API with `AWS_IAM` auth from
 * the Smithy OpenAPI, a resource policy that admits only the control
 * plane's `<fleet>-global-hook` role and the edge operator role and denies
 * every other principal (spike S-8, M-6), and its function.
 */
class Registrar extends Construct {
  public readonly url: string;
  public readonly function: NodejsFunction;

  constructor(scope: Construct, id: string, props: RegistrarProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const { inputs } = props;

    const env: Record<keyof typeof REGISTRAR_ENV, string> = {
      routeTableArn: props.routeTableArn,
      appDomain: inputs.appDomain,
      addressing: inputs.addressing,
      applicationId: inputs.applicationId,
      controlPlaneUrl: inputs.controlPlane.apiUrl,
      controlPlaneAccount: inputs.controlPlane.accountId,
      controlPlaneRegion: inputs.controlPlane.region,
      vendorIdpTokenUrl: inputs.controlPlane.vendorIdp.tokenUrl,
      vendorIdpClientId: inputs.controlPlane.vendorIdp.clientId,
      vendorIdpSecretArn: inputs.controlPlane.vendorIdp.clientSecretArn,
      fleet: inputs.fleet,
      edgeOperatorRoleArn: inputs.edgeOperatorRoleArn,
      dedicatedDomains: inputs.dedicatedDomains ? 'on' : 'off',
      distributionId: props.distributionId,
      connectionGroupId: props.connectionGroupId,
    };
    const environment = Object.fromEntries(
      Object.entries(env).map(([k, v]) => [REGISTRAR_ENV[k as keyof typeof REGISTRAR_ENV], v]),
    );

    const fn = new NodejsFunction(this, 'Function', {
      entry: props.entry,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: REGISTRAR_TIMEOUT,
      tracing: lambda.Tracing.ACTIVE,
      environment,
      logGroup: new logs.LogGroup(this, 'Logs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY, // sample only
      }),
      loggingFormat: lambda.LoggingFormat.JSON,
      description: 'Tenant front door route registrar (spec §3.4)',
      bundling: {
        minify: true,
        sourceMap: false,
        externalModules: [],
        // The Smithy server SDK validates with re2-wasm, which reads its
        // wasm binary from disk; esbuild does not bundle it.
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [`cp "${inputDir}/node_modules/re2-wasm/build/wasm/re2.wasm" "${outputDir}/"`],
        },
      },
    });
    // The route table's data plane (§3.4 step 5). No ListKeys: the
    // registrar reads the keys it writes, never the whole store. Every
    // write is one UpdateKeys under the store's ETag, so no PutKey or
    // DeleteKey either.
    fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'RouteTable',
      actions: [
        'cloudfront-keyvaluestore:DescribeKeyValueStore',
        'cloudfront-keyvaluestore:GetKey',
        'cloudfront-keyvaluestore:UpdateKeys',
      ],
      resources: [props.routeTableArn],
    }));
    // The reader token's client secret (ADR-0015).
    fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'VendorIdpClientSecret',
      actions: ['secretsmanager:GetSecretValue'],
      resources: [inputs.controlPlane.vendorIdp.clientSecretArn],
    }));
    // The dedicated-domain actions, only while `dedicatedDomains` is on
    // (§3.4). The function depends on them, so turning the switch on grants
    // them before the function serves `customDomain`; turning it off
    // removes them in the update's cleanup, after the guard.
    if (inputs.dedicatedDomains) {
      // On the function resource alone: its role is in its subtree, and the policy names the role.
      (fn.node.defaultChild as lambda.CfnFunction).node.addDependency(
        registrarDedicatedDomainsPolicy(this, 'DedicatedDomainsPolicy', fn.role!, props.distributionId),
      );
    }
    this.function = fn;
    acknowledge(fn, BASIC_EXECUTION_ROLE_FINDING, 'Logs-only managed policy NodejsFunction attaches; a scoped copy changes no access (M-36).');
    acknowledge(fn, 'AwsSolutions-L1', 'Node.js 24, the runtime the demo cell API uses too, so the sample runs on one runtime; move both when Node.js 26 is GA.');
    acknowledge(
      fn,
      'AwsSolutions-IAM5[Resource::*]',
      'Active X-Ray tracing grants xray:PutTraceSegments and PutTelemetryRecords, which take no resource ARN (M-18).',
    );

    const hookRoleArn = `arn:${inputs.partition}:iam::${inputs.controlPlane.accountId}:role/${inputs.fleet}-global-hook`;
    const admitted = [hookRoleArn, inputs.edgeOperatorRoleArn];

    const definition = allowEmptyBody(patchIntegrations(
      readRegistrarOpenApi(),
      `arn:${stack.partition}:apigateway:${stack.region}:lambda:path/2015-03-31/functions/${fn.functionArn}/invocations`,
    ));
    const accessLogs = new logs.LogGroup(this, 'AccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY, // sample only
    });
    const api = new apigateway.SpecRestApi(this, 'Api', {
      restApiName: `${stack.stackName}-registrar`,
      apiDefinition: apigateway.ApiDefinition.fromInline(definition),
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      // The access log and the ERROR execution log need the account's API
      // Gateway CloudWatch Logs role (`aws apigateway update-account`), a
      // per-account setting that CDK would retain on destroy, so the
      // deployer sets it once, as for tenant-identity (deployment
      // prerequisite).
      cloudWatchRole: false,
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            sid: 'AdmitHookAndOperator',
            principals: [new iam.AnyPrincipal()],
            actions: ['execute-api:Invoke'],
            resources: ['execute-api:/*'],
            conditions: { ArnLike: { 'aws:PrincipalArn': admitted } },
          }),
          // Without it any edge-account principal whose identity policy
          // allows execute-api:Invoke gets in (spike S-8, T-18).
          new iam.PolicyStatement({
            sid: 'DenyEveryOtherPrincipal',
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: ['execute-api:Invoke'],
            resources: ['execute-api:/*'],
            conditions: { ArnNotLike: { 'aws:PrincipalArn': admitted } },
          }),
        ],
      }),
      deployOptions: {
        stageName: REGISTRAR_STAGE,
        // Who called (M-18): the SigV4 caller and its account, never a body.
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogs),
        accessLogFormat: apigateway.AccessLogFormat.custom(JSON.stringify({
          requestId: apigateway.AccessLogField.contextRequestId(),
          requestTime: apigateway.AccessLogField.contextRequestTime(),
          httpMethod: apigateway.AccessLogField.contextHttpMethod(),
          resourcePath: apigateway.AccessLogField.contextResourcePath(),
          status: apigateway.AccessLogField.contextStatus(),
          responseLength: apigateway.AccessLogField.contextResponseLength(),
          callerArn: apigateway.AccessLogField.contextIdentityUserArn(),
          callerAccount: apigateway.AccessLogField.contextIdentityAccountId(),
          sourceIp: apigateway.AccessLogField.contextIdentitySourceIp(),
          errorMessage: apigateway.AccessLogField.contextErrorMessage(),
        })),
        loggingLevel: apigateway.MethodLoggingLevel.ERROR,
        dataTraceEnabled: false,
        tracingEnabled: true,
        throttlingRateLimit: REGISTRAR_THROTTLE.rateLimit,
        throttlingBurstLimit: REGISTRAR_THROTTLE.burstLimit,
      },
    });
    fn.addPermission('ApiInvoke', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: api.arnForExecuteApi(),
    });
    acknowledge(
      api,
      'AwsSolutions-APIG2',
      'Request validation is on: the Smithy OpenAPI sets x-amazon-apigateway-request-validator per operation; '
      + 'SpecRestApi creates no CfnRequestValidator for the rule to see (spec §5.1).',
    );
    acknowledge(
      api,
      'AwsSolutions-APIG3',
      'The resource policy admits two IAM roles and denies every other principal before any request is served (M-6, spike S-8); '
      + 'the stage throttle bounds the rate.',
    );
    acknowledge(
      api,
      'AwsSolutions-APIG4',
      'Every operation is AWS_IAM (the Smithy model\'s sigv4 security scheme), which the rule cannot see in a SpecRestApi (spec §5.1, M-6).',
    );
    acknowledge(
      api,
      'AwsSolutions-COG4',
      'The registrar authorises with AWS_IAM, never a Cognito user pool: its callers are two IAM roles (spec §3.4, M-6).',
    );
    this.url = api.url;
  }
}
