// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `DemoCellApi`: the demo cell API a cell stack deploys (spec §3.1 Cell API
 * origin, §6.1). It holds the function (`cell-api.function.ts`), its
 * function URL with `AWS_IAM` auth (origin access control signs every
 * request, ADR-0011), the `CellRouteAccess` grant for the edge
 * distribution, and, when the origin rate limit is on, the per-tenant
 * counter table (ADR-0009).
 *
 * `apiDomain` is the function URL's host name: the cell script writes it
 * as its `frontDoorApiDomain` output (§5.2), which the route hook sends to
 * the registrar.
 *
 * The function's role can read only the cell's own tenant namespaces for
 * this application (the hosts check, §3.5), update only the counter table,
 * and write only its own log group. It holds no write on SSM and nothing in
 * the edge account.
 */

import * as path from 'node:path';
import { Duration, Fn, RemovalPolicy, Stack, Token, Validations } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { APPLICATION_ID, CellRouteAccess } from './cell-route-access.cdk';
import { CELL_API_ENV } from './env';
import { TENANT_CLAIM } from '../shared/contracts';

export interface CellApiIssuer {
  /** The issuer's `iss`, an `https` URL. */
  readonly issuer: string;
  /** The issuer's JWKS URL, `https`. */
  readonly jwksUrl: string;
  /** App clients whose tokens the cell accepts (`client_id`, or `aud`). */
  readonly clientIds: readonly string[];
}

export interface DemoCellApiProps {
  readonly issuer: CellApiIssuer;
  /** The control-plane application; names the tenant namespaces the hosts check reads. */
  readonly applicationId: string;
  /** The control-plane cell id, returned by `/api/whoami`. */
  readonly cellId: string;
  /** The claim that names the tenant (§3.6). Default `tenant_id`. */
  readonly tenantClaim?: string;
  /**
   * The per-tenant rate at the origin, per verified tenant per 5 minutes
   * (§3.6, ADR-0009). Default 2,000. `0` turns it off and creates no table:
   * use that in `host` mode, where the edge's WAF rule limits each host.
   */
  readonly tenantRequestsPer5Min?: number;
  /** The edge distribution's ARN; omit to read it from the cell-account copy parameter (§6.4). */
  readonly distributionArn?: string;
  /** Default one month. */
  readonly logRetention?: logs.RetentionDays;
}

const DEFAULT_REQUESTS_PER_5MIN = 2000;
const CLAIM_NAME = /^[A-Za-z0-9_:.-]{1,64}$/;
const CELL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class DemoCellApi extends Construct {
  public readonly function: NodejsFunction;
  public readonly functionUrl: lambda.FunctionUrl;
  /** The function URL's host name: the cell script's `frontDoorApiDomain` output (§5.2). */
  public readonly apiDomain: string;
  public readonly routeAccess: CellRouteAccess;
  /** The per-tenant counter table; undefined when the origin rate limit is off. */
  public readonly limitTable?: dynamodb.TableV2;
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: DemoCellApiProps) {
    super(scope, id);
    const tenantClaim = props.tenantClaim ?? TENANT_CLAIM;
    const limit = props.tenantRequestsPer5Min ?? DEFAULT_REQUESTS_PER_5MIN;
    validate(props, tenantClaim, limit);

    this.logGroup = new logs.LogGroup(this, 'Logs', {
      retention: props.logRetention ?? logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY, // sample only
    });
    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Demo cell API: reads its own tenant namespaces, counts per-tenant requests, writes its log group',
    });
    this.logGroup.grantWrite(role);
    const stack = Stack.of(this);
    const namespaces = stack.formatArn({ service: 'ssm', resource: 'parameter', resourceName: `application-plane/tenants/*/${props.applicationId}` });
    role.addToPolicy(new iam.PolicyStatement({ actions: ['ssm:GetParametersByPath'], resources: [namespaces] }));

    const environment: Record<string, string> = {
      [CELL_API_ENV.issuer]: props.issuer.issuer,
      [CELL_API_ENV.jwksUrl]: props.issuer.jwksUrl,
      [CELL_API_ENV.allowedClientIds]: props.issuer.clientIds.join(','),
      [CELL_API_ENV.tenantClaim]: tenantClaim,
      [CELL_API_ENV.applicationId]: props.applicationId,
      [CELL_API_ENV.cellId]: props.cellId,
      [CELL_API_ENV.tenantRequestsPer5Min]: String(limit),
    };
    if (limit > 0) {
      this.limitTable = new dynamodb.TableV2(this, 'TenantLimits', {
        partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
        billing: dynamodb.Billing.onDemand(),
        timeToLiveAttribute: 'expiresAt',
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        removalPolicy: RemovalPolicy.DESTROY, // sample only
      });
      this.limitTable.grant(role, 'dynamodb:UpdateItem');
      environment[CELL_API_ENV.limitTable] = this.limitTable.tableName;
    }

    this.function = new NodejsFunction(this, 'Function', {
      entry: path.join(__dirname, 'cell-api.function.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      role,
      logGroup: this.logGroup,
      loggingFormat: lambda.LoggingFormat.JSON,
      environment,
      description: 'Demo cell API behind the tenant front door (GET /api/whoami)',
      bundling: { minify: true, sourceMap: false, externalModules: [] },
    });

    this.functionUrl = this.function.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    // https://<id>.lambda-url.<region>.on.aws/ -> <id>.lambda-url.<region>.on.aws
    this.apiDomain = Fn.select(2, Fn.split('/', this.functionUrl.url));
    this.routeAccess = new CellRouteAccess(this, 'RouteAccess', {
      function: this.function,
      distributionArn: props.distributionArn,
      applicationId: props.applicationId,
    });

    // cdk-nag: the construct carries its own acknowledgments (standard §4.5).
    // A granular id holds several '::', which Validations.acknowledge() refuses,
    // so it is recorded as the metadata cdk-nag reads.
    role.node.findChild('DefaultPolicy').node.findChild('Resource').node.addMetadata(Validations.ACKNOWLEDGED_RULES_METADATA_KEY, {
      [`AwsSolutions-IAM5[Resource::${nagResource(stack.resolve(namespaces))}]`]:
        'The hosts check reads the namespace of whichever verified tenant calls, one path per tenant, so the tenant segment is a ' +
        'wildcard; the application segment is fixed and the action is read-only (threat model M-2, spec §3.5).',
    });
    Validations.of(this.function).acknowledge({
      id: 'AwsSolutions-L1',
      reason: 'Node.js 24 is the runtime the cell API checks (threat model M-2, M-28) are tested on; the sample moves runtimes together.',
    });
  }
}

/** A resolved ARN the way cdk-nag renders it in a finding id: intrinsics flattened to `<Name>`. */
function nagResource(value: unknown): string {
  if (typeof value === 'string') return value;
  const node = value as { 'Ref'?: string; 'Fn::Join'?: [string, unknown[]] };
  if (node.Ref !== undefined) return `<${node.Ref}>`;
  if (node['Fn::Join'] !== undefined) return node['Fn::Join'][1].map(nagResource).join(node['Fn::Join'][0]);
  return JSON.stringify(value);
}

function validate(props: DemoCellApiProps, tenantClaim: string, limit: number): void {
  if (!Token.isUnresolved(props.applicationId) && !APPLICATION_ID.test(props.applicationId)) {
    throw new Error(`DemoCellApi: applicationId must match ${APPLICATION_ID}`);
  }
  if (!Token.isUnresolved(props.cellId) && !CELL_ID.test(props.cellId)) {
    throw new Error(`DemoCellApi: cellId must match ${CELL_ID}`);
  }
  for (const [name, value] of [['issuer.issuer', props.issuer.issuer], ['issuer.jwksUrl', props.issuer.jwksUrl]] as const) {
    if (!Token.isUnresolved(value) && !isHttpsUrl(value)) {
      throw new Error(`DemoCellApi: ${name} must be an https URL`);
    }
  }
  if (props.issuer.clientIds.length === 0 || props.issuer.clientIds.some((c) => c.length === 0 || c.includes(','))) {
    throw new Error('DemoCellApi: issuer.clientIds must hold at least one non-empty id without a comma');
  }
  if (!CLAIM_NAME.test(tenantClaim)) {
    throw new Error(`DemoCellApi: tenantClaim must match ${CLAIM_NAME}`);
  }
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error('DemoCellApi: tenantRequestsPer5Min must be a non-negative integer');
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
