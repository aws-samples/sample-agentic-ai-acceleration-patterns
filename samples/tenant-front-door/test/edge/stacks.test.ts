// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Stage } from 'aws-cdk-lib';
import { Match } from 'aws-cdk-lib/assertions';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import { BASE_PROPS, CONTROL_PLANE_ACCOUNT, EDGE_ACCOUNT, FIXTURES, FULL_HOST_PROPS, only, OPERATOR_ROLE_ARN, synth } from './helpers';
import { ACCESS_LOG_FIELDS, FORBIDDEN_LOG_FIELDS } from '../../src/edge/edge-logging.cdk';
import { RATE_RULE_HEADER } from '../../src/edge/edge.cdk';
import { MAX_ROUTER_BYTES, REGISTRAR_STAGE, unroutedCellOrigin } from '../../src/edge/main.cdk';
import { API_FORWARDED_HEADERS, PARAM_EDGE, REGISTRAR_ENV, ROUTER_TOKENS } from '../../src/shared/contracts';
import { appEntry, encodeEntry, METRIC_NAMESPACE, METRIC_ROUTE_TABLE_BYTES, RESERVED_LABELS, STORE_ALARM_BYTES } from '../../src/shared/route-table';

const single = synth(BASE_PROPS);
const host = synth(FULL_HOST_PROPS);

const ALL_VIEWER_EXCEPT_HOST_HEADER = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';
const CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';

function distributionConfig(s = single): Record<string, any> {
  return only(s.main, 'AWS::CloudFront::Distribution').DistributionConfig;
}

function behaviours(s = single): Record<string, any>[] {
  const c = distributionConfig(s);
  return [{ ...c.DefaultCacheBehavior, PathPattern: '*' }, ...c.CacheBehaviors];
}

function behaviour(pattern: string, s = single): Record<string, any> {
  const b = behaviours(s).find((x) => x.PathPattern === pattern);
  if (b === undefined) throw new Error(`no ${pattern} behaviour`);
  return b;
}

function routerCode(s = single): string {
  return only(s.main, 'AWS::CloudFront::Function').FunctionCode;
}

function policyStatements(s: typeof single, roleLogicalIdPrefix: string): any[] {
  return Object.entries(s.main.findResources('AWS::IAM::Policy'))
    .filter(([, r]) => JSON.stringify(r.Properties.Roles).includes(roleLogicalIdPrefix))
    .flatMap(([, r]) => r.Properties.PolicyDocument.Statement);
}

describe('the four stacks of spec §3.1 (wave 1: three edge-account stacks)', () => {
  it('puts the edge and edge logging stacks in us-east-1 and the main stack in the control plane\'s Region (ADR-0010)', () => {
    const { edgeStack, mainStack, edgeLoggingStack } = single.frontDoor;
    expect([edgeStack.stackName, mainStack.stackName, edgeLoggingStack.stackName]).toEqual(['Tfd-edge', 'Tfd-main', 'Tfd-edge-logging']);
    expect([edgeStack.region, mainStack.region, edgeLoggingStack.region]).toEqual(['us-east-1', 'eu-central-1', 'us-east-1']);
    expect(new Set([edgeStack.account, mainStack.account, edgeLoggingStack.account])).toEqual(new Set([EDGE_ACCOUNT]));
  });

  it('deploys edge, then main, then edge logging (ADR-0010)', () => {
    const { edgeStack, mainStack, edgeLoggingStack } = single.frontDoor;
    expect(mainStack.dependencies).toContain(edgeStack);
    expect(edgeLoggingStack.dependencies).toContain(mainStack);
  });

  it('exposes the §6.4 construct properties', () => {
    const fd = host.frontDoor;
    expect(fd.appDomain).toBe('app.example.com');
    expect(fd.addressing).toBe('host');
    for (const v of [fd.distributionId, fd.distributionArn, fd.routeTableArn, fd.registrarUrl, fd.pooledTenantId]) {
      expect(typeof v).toBe('string');
    }
  });

  it('passes cdk-nag AwsSolutionsChecks with its own acknowledgements, both modes, dedicatedDomains off and on (standard §4.3, §4.5)', () => {
    expect(() => synth(BASE_PROPS, true)).not.toThrow();
    expect(() => synth(FULL_HOST_PROPS, true)).not.toThrow();
    expect(() => synth({ ...BASE_PROPS, dedicatedDomains: true }, true)).not.toThrow();
    expect(() => synth({ ...FULL_HOST_PROPS, dedicatedDomains: true }, true)).not.toThrow();
  });
});

describe('edge stack (spec §3.1, ADR-0009, ADR-0021)', () => {
  it('certifies appDomain alone in single mode, DNS-validated in the zone', () => {
    single.edge.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'app.example.com',
      SubjectAlternativeNames: Match.absent(),
      ValidationMethod: 'DNS',
      DomainValidationOptions: [{ DomainName: 'app.example.com', HostedZoneId: 'Z0123456789EXAMPLE' }],
    });
  });

  it('adds *.appDomain in host mode', () => {
    host.edge.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'app.example.com',
      SubjectAlternativeNames: ['*.app.example.com'],
    });
  });

  it('has a CloudFront-scope web ACL with no rate rule in single mode, where the cell limits (ADR-0009)', () => {
    const acl = only(single.edge, 'AWS::WAFv2::WebACL');
    expect(acl.Scope).toBe('CLOUDFRONT');
    expect(acl.DefaultAction).toEqual({ Allow: {} });
    expect(acl.Rules).toEqual([]);
  });

  it('counts per client IP and host first, then per host, on /api/ and /agents/ only, each with its custom 429 (ADR-0021, ADR-0009)', () => {
    const acl = only(host.edge, 'AWS::WAFv2::WebACL');
    const [ip, perHost] = acl.Rules;
    const host_ = { Header: { Name: 'host', TextTransformations: [{ Priority: 0, Type: 'LOWERCASE' }] } };
    expect(ip.Priority).toBeLessThan(perHost.Priority);
    expect(ip.Statement.RateBasedStatement).toMatchObject({ Limit: 600, EvaluationWindowSec: 300, AggregateKeyType: 'CUSTOM_KEYS', CustomKeys: [host_, { IP: {} }] });
    expect(perHost.Statement.RateBasedStatement).toMatchObject({ Limit: 3000, EvaluationWindowSec: 300, CustomKeys: [host_] });
    for (const [rule, tag] of [[ip, 'ip'], [perHost, 'host']]) {
      const scope = rule.Statement.RateBasedStatement.ScopeDownStatement.OrStatement.Statements;
      expect(scope.map((s: any) => [s.ByteMatchStatement.PositionalConstraint, s.ByteMatchStatement.SearchString, s.ByteMatchStatement.FieldToMatch]))
        .toEqual([['STARTS_WITH', '/api/', { UriPath: {} }], ['STARTS_WITH', '/agents/', { UriPath: {} }]]);
      const response = rule.Action.Block.CustomResponse;
      expect(response.ResponseCode).toBe(429);
      expect(response.ResponseHeaders).toContainEqual({ Name: RATE_RULE_HEADER, Value: tag });
      expect(response.ResponseHeaders).toContainEqual({ Name: 'cache-control', Value: 'no-store' });
      expect(acl.CustomResponseBodies[response.CustomResponseBodyKey].ContentType).toBe('APPLICATION_JSON');
    }
  });
});

describe('main stack: distribution (spec §3.1, §3.2, ADR-0002)', () => {
  it('is a multi-tenant distribution with the edge stack\'s certificate and web ACL, and none of the settings tenant-only refuses', () => {
    const c = distributionConfig();
    expect(c.ConnectionMode).toBe('tenant-only');
    expect(c.ViewerCertificate).toEqual({
      AcmCertificateArn: expect.anything(),
      SslSupportMethod: 'sni-only',
      MinimumProtocolVersion: 'TLSv1.2_2021',
    });
    expect(c.WebACLId).toBeDefined();
    for (const refused of ['Aliases', 'PriceClass', 'IPV6Enabled', 'Logging', 'DefaultTTL', 'ForwardedValues']) {
      expect(c[refused]).toBeUndefined();
    }
  });

  it('runs the router on every behaviour and the one response headers policy on every behaviour (§3.3, §7.1)', () => {
    const policies = new Set();
    for (const s of [single, host]) {
      for (const b of behaviours(s)) {
        expect(b.FunctionAssociations).toEqual([{ EventType: 'viewer-request', FunctionARN: expect.anything() }]);
        policies.add(JSON.stringify(b.ResponseHeadersPolicyId));
      }
    }
    expect(behaviours(host).map((b) => b.PathPattern)).toEqual(['*', '/assets/*', '/api/*', '/agents/*']);
    expect(policies.size).toBe(1);
  });

  it('serves the SPA from the bucket through origin access control, GET and HEAD only (§3.2)', () => {
    const c = distributionConfig();
    const spa = c.Origins.find((o: any) => o.Id === 'spa');
    expect(spa.OriginAccessControlId).toBeDefined();
    expect(spa.S3OriginConfig).toEqual({ OriginAccessIdentity: '' });
    for (const p of ['*', '/assets/*']) {
      expect(behaviour(p)).toMatchObject({ TargetOriginId: 'spa', AllowedMethods: ['GET', 'HEAD'], ViewerProtocolPolicy: 'redirect-to-https' });
    }
    single.main.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: { OriginAccessControlOriginType: 's3', SigningBehavior: 'always', SigningProtocol: 'sigv4' },
    });
  });

  it('caches the SPA by its own Cache-Control, keyed on nothing a tenant sends (§3.2, M-33)', () => {
    single.main.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: {
        MinTTL: 0,
        ParametersInCacheKeyAndForwardedToOrigin: {
          HeadersConfig: { HeaderBehavior: 'none' },
          CookiesConfig: { CookieBehavior: 'none' },
          QueryStringsConfig: { QueryStringBehavior: 'none' },
        },
      },
    });
  });

  it('forwards exactly the four /api/* headers, every query string and no cookie, with caching disabled (§3.2, M-3)', () => {
    const api = behaviour('/api/*');
    expect(api).toMatchObject({ TargetOriginId: 'cell', CachePolicyId: CACHING_DISABLED, ViewerProtocolPolicy: 'https-only' });
    expect(api.AllowedMethods).toEqual(expect.arrayContaining(['POST', 'PUT', 'DELETE']));
    const orp = only(single.main, 'AWS::CloudFront::OriginRequestPolicy').OriginRequestPolicyConfig;
    expect(orp.HeadersConfig).toEqual({ HeaderBehavior: 'whitelist', Headers: [...API_FORWARDED_HEADERS] });
    expect(orp.HeadersConfig.Headers).not.toContain('host');
    expect(orp.HeadersConfig.Headers).not.toContain('authorization');
    expect(orp.QueryStringsConfig).toEqual({ QueryStringBehavior: 'all' });
    expect(orp.CookiesConfig).toEqual({ CookieBehavior: 'none' });
  });

  it('gives /api/* an https placeholder origin the router always replaces (§3.3 step 7)', () => {
    const cell = distributionConfig().Origins.find((o: any) => o.Id === 'cell');
    expect(cell.DomainName).toBe(unroutedCellOrigin('eu-central-1'));
    expect(cell.CustomOriginConfig).toMatchObject({ OriginProtocolPolicy: 'https-only', OriginSSLProtocols: ['TLSv1.2'] });
  });

  it('has no /agents/* behaviour or origin with agentIngress off (§3.3 step 3)', () => {
    expect(behaviours().map((b) => b.PathPattern)).not.toContain('/agents/*');
    expect(distributionConfig().Origins.map((o: any) => o.Id)).toEqual(['spa', 'cell']);
  });

  it('streams /agents/* to the ingress with Managed-AllViewerExceptHostHeader and its stage as origin path (§3.2, ADR-0019)', () => {
    expect(behaviour('/agents/*', host)).toMatchObject({
      TargetOriginId: 'agents',
      CachePolicyId: CACHING_DISABLED,
      OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST_HEADER,
    });
    const agents = distributionConfig(host).Origins.find((o: any) => o.Id === 'agents');
    expect(agents).toMatchObject({ DomainName: 'ingress.example.com', OriginPath: '/prod', CustomOriginConfig: { OriginProtocolPolicy: 'https-only' } });
    expect(agents.OriginAccessControlId).toBeUndefined();
  });

  it('serves appDomain (single) or *.appDomain (host) from one pooled distribution tenant on its own connection group, with a CNAME (spike S-1)', () => {
    for (const [s, domain] of [[single, 'app.example.com'], [host, '*.app.example.com']] as const) {
      const tenant = only(s.main, 'AWS::CloudFront::DistributionTenant');
      expect(tenant.Domains).toEqual([domain]);
      expect(tenant.Customizations).toBeUndefined();
      expect(tenant.ConnectionGroupId).toEqual({ 'Fn::GetAtt': ['ConnectionGroup', 'Id'] });
      s.main.hasResourceProperties('AWS::Route53::RecordSet', {
        Name: `${domain}.`,
        Type: 'CNAME',
        HostedZoneId: 'Z0123456789EXAMPLE',
        ResourceRecords: [{ 'Fn::GetAtt': ['ConnectionGroup', 'RoutingEndpoint'] }],
      });
    }
  });
});

describe('main stack: router and route table (spec §3.3, §4.1)', () => {
  it('is a JS 2.0 viewer-request function associated with the route table', () => {
    const fn = only(single.main, 'AWS::CloudFront::Function');
    expect(fn.FunctionConfig.Runtime).toBe('cloudfront-js-2.0');
    expect(fn.FunctionConfig.KeyValueStoreAssociations).toEqual([{ KeyValueStoreARN: { 'Fn::GetAtt': [expect.stringMatching(/^RouteTable/), 'Arn'] } }]);
    expect(fn.AutoPublish).toBe(true);
  });

  it('compiles the stack\'s values into the router in place of every ROUTER_TOKENS literal', () => {
    for (const token of Object.values(ROUTER_TOKENS)) {
      expect(routerCode()).not.toContain(token);
    }
    expect(routerCode()).toContain('const APP_DOMAIN = "app.example.com";');
    expect(routerCode()).toContain('const ADDRESSING = "single";');
    expect(routerCode()).toContain('const TENANT_CLAIM = "tenant_id";');
    expect(routerCode()).toContain('const AGENT_INGRESS = "off";');
    expect(routerCode()).toContain(`const RESERVED_LABELS = "${RESERVED_LABELS.join(',')}";`);
    expect(routerCode(host)).toContain('const ADDRESSING = "host";');
    expect(routerCode(host)).toContain('const TENANT_CLAIM = "custom:tenant";');
    expect(routerCode(host)).toContain('const AGENT_INGRESS = "on";');
  });

  it('fails synth when the router is missing, misses a token or exceeds CloudFront Functions\' 10 KB', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfd-router-'));
    const stub = fs.readFileSync(path.join(FIXTURES, 'router-stub.js'), 'utf8');
    const missingToken = path.join(dir, 'missing.js');
    fs.writeFileSync(missingToken, stub.replace('"__TFD_ADDRESSING__"', '"single"'));
    const big = path.join(dir, 'big.js');
    fs.writeFileSync(big, `${stub}\n// ${'x'.repeat(MAX_ROUTER_BYTES)}`);
    expect(() => synth({ ...BASE_PROPS, routerSourcePath: path.join(dir, 'absent.js') })).toThrow(/build slice S1/);
    expect(() => synth({ ...BASE_PROPS, routerSourcePath: missingToken })).toThrow(/router source has no "__TFD_ADDRESSING__"/);
    expect(() => synth({ ...BASE_PROPS, routerSourcePath: big })).toThrow(/over CloudFront Functions' 10240/);
  });

  it('writes the app key with the §4.1 builder, and signin ids only in host mode, never key material (M-20)', () => {
    const app = (issuer: { az: string; tk: string; lo: string; ex?: string }) =>
      encodeEntry(appEntry({ ...issuer, cid: 'spa-client', sc: 'openid email' }));
    const singleKeys = only(single.main, 'Custom::TenantFrontDoorRouteTableKeys');
    expect(singleKeys.App).toBe(app({
      az: 'https://login.auth.example.com/oauth2/authorize',
      tk: 'https://login.auth.example.com/oauth2/token',
      lo: 'https://login.auth.example.com/logout',
    }));
    expect(singleKeys.SigninIds).toBeUndefined();
    const hostKeys = only(host.main, 'Custom::TenantFrontDoorRouteTableKeys');
    expect(JSON.parse(hostKeys.App).ex).toBe('https://exchange.example.com/oauth2/token');
    expect(hostKeys.SigninIds).toEqual(['k1', 'k2']);
    expect(hostKeys.SigninCurrent).toBe('k2');
    expect(Object.keys(hostKeys).sort()).toEqual(['App', 'KeyValueStoreArn', 'ServiceToken', 'SigninCurrent', 'SigninIds']);
  });

  it('gives the key writer the store\'s describe, read and batch write, on this store only', () => {
    const statements = policyStatements(single, 'RouteTableKeysFunction');
    expect(statements).toEqual([{
      Effect: 'Allow',
      Action: ['cloudfront-keyvaluestore:DescribeKeyValueStore', 'cloudfront-keyvaluestore:GetKey', 'cloudfront-keyvaluestore:UpdateKeys'],
      Resource: { 'Fn::GetAtt': [expect.stringMatching(/^RouteTable/), 'Arn'] },
    }]);
  });

  it('alarms at 80 % of the store on the registrar\'s RouteTableBytes maximum, to alarmTopicArn (§4.1, M-43, M-48)', () => {
    const props = {
      Namespace: METRIC_NAMESPACE,
      MetricName: METRIC_ROUTE_TABLE_BYTES,
      Statistic: 'Maximum',
      Threshold: STORE_ALARM_BYTES,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    };
    expect(only(single.main, 'AWS::CloudWatch::Alarm')).toMatchObject(props);
    expect(only(single.main, 'AWS::CloudWatch::Alarm').AlarmActions).toBeUndefined();
    expect(only(host.main, 'AWS::CloudWatch::Alarm')).toMatchObject({
      ...props,
      AlarmActions: [`arn:aws:sns:eu-central-1:${EDGE_ACCOUNT}:front-door-alarms`],
    });
  });
});

describe('main stack: response headers policy (spec §7.1, M-30)', () => {
  const config = (s = single) => only(s.main, 'AWS::CloudFront::ResponseHeadersPolicy').ResponseHeadersPolicyConfig;

  it('sets the §7.1 security headers, overriding the origin, with HSTS without includeSubDomains or preload', () => {
    const h = config().SecurityHeadersConfig;
    expect(h.StrictTransportSecurity).toEqual({ AccessControlMaxAgeSec: 31536000, IncludeSubdomains: false, Preload: false, Override: true });
    expect(h.FrameOptions).toEqual({ FrameOption: 'DENY', Override: true });
    expect(h.ContentTypeOptions).toEqual({ Override: true });
    expect(h.ReferrerPolicy).toEqual({ ReferrerPolicy: 'strict-origin-when-cross-origin', Override: true });
    expect(config().CustomHeadersConfig.Items).toEqual([
      { Header: 'Cross-Origin-Opener-Policy', Value: 'same-origin', Override: true },
      { Header: 'Cross-Origin-Resource-Policy', Value: 'same-origin', Override: true },
      { Header: 'Permissions-Policy', Value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()', Override: true },
    ]);
  });

  it('builds the CSP from csp.json and the issuer origins, single mode', () => {
    const csp = config().SecurityHeadersConfig.ContentSecurityPolicy;
    expect(csp.Override).toBe(true);
    const hashes = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'spa', 'csp.json'), 'utf8'))['script-src'];
    expect(csp.ContentSecurityPolicy.startsWith(`default-src 'self'; script-src ${hashes.join(' ')} 'strict-dynamic' 'report-sample'; `)).toBe(true);
    expect(csp.ContentSecurityPolicy).toContain("connect-src 'self' https://login.auth.example.com;");
    expect(csp.ContentSecurityPolicy).toContain("form-action 'self' https://login.auth.example.com;");
    expect(csp.ContentSecurityPolicy).not.toContain('report-to');
  });

  it('adds the exchange origin, the sign-in host, report-to fd and Reporting-Endpoints in host mode with reporting', () => {
    const csp = config(host).SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy;
    expect(csp).toContain("connect-src 'self' https://login.auth.example.com https://exchange.example.com;");
    expect(csp).toContain("form-action 'self' https://login.auth.example.com https://login.app.example.com;");
    expect(csp.endsWith('; report-to fd')).toBe(true);
    expect(config(host).CustomHeadersConfig.Items).toContainEqual({ Header: 'Reporting-Endpoints', Value: 'fd="https://reports.example.com/csp"', Override: true });
  });
});

describe('main stack: SPA bucket (spec §3.1, M-44, ADR-0023)', () => {
  it('blocks public access, enforces the owner, versions, encrypts and is emptied at teardown', () => {
    single.main.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
      VersioningConfiguration: { Status: 'Enabled' },
      BucketEncryption: Match.anyValue(),
    });
    single.main.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
  });

  it('lets only this distribution read, and denies object writes to every principal but the two deployment roles', () => {
    const statements = only(single.main, 'AWS::S3::BucketPolicy').PolicyDocument.Statement;
    const read = statements.find((s: any) => s.Sid === 'DistributionReads');
    expect(read).toMatchObject({ Effect: 'Allow', Principal: { Service: 'cloudfront.amazonaws.com' }, Action: 's3:GetObject' });
    expect(JSON.stringify(read.Condition.StringEquals['AWS:SourceArn'])).toContain(':cloudfront::111111111111:distribution/');
    const deny = statements.find((s: any) => s.Sid === 'DeploymentRolesOnlyWrite');
    expect(deny).toMatchObject({ Effect: 'Deny', Principal: { AWS: '*' }, Action: ['s3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion'] });
    const writers = deny.Condition.ArnNotEquals['aws:PrincipalArn'].map((r: any) => r['Fn::GetAtt'][0]);
    expect(writers).toHaveLength(2);
    expect(writers[0]).toMatch(/^CustomCDKBucketDeployment.*ServiceRole/);
    expect(writers[1]).toMatch(/^CustomS3AutoDeleteObjectsCustomResourceProviderRole/);
    // Those two roles are the only Allow principals that can write.
    const allowWriters = statements.filter((s: any) => s.Effect === 'Allow' && JSON.stringify(s.Action).match(/Put|Delete/));
    expect(allowWriters.map((s: any) => s.Principal.AWS['Fn::GetAtt'][0])).toEqual([writers[1]]);
  });

  it('uploads /assets/ immutable and the shell no-cache, without pruning and without csp.json, after the policy (§3.2, ADR-0008)', () => {
    const deployments = Object.values(single.main.findResources('Custom::CDKBucketDeployment'));
    expect(deployments.map((d) => [d.Properties.DestinationBucketKeyPrefix, d.Properties.SystemMetadata['cache-control'], d.Properties.Prune])).toEqual([
      ['assets/', 'public, max-age=31536000, immutable', false],
      [undefined, 'no-cache', false],
    ]);
    for (const d of deployments) {
      expect(d.DependsOn).toEqual(expect.arrayContaining(['Distribution', expect.stringMatching(/^ResponseHeaders/)]));
    }
    const shell = single.frontDoor.mainStack.node.findAll().find((c) => c.node.id === 'SpaShellSource') as s3assets.Asset;
    const staged = path.join(Stage.of(single.frontDoor.mainStack)!.outdir, shell.assetPath);
    expect(fs.existsSync(path.join(staged, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(staged, 'csp.json'))).toBe(false);
    expect(fs.existsSync(path.join(staged, 'assets'))).toBe(false);
  });
});

describe('main stack: registrar (spec §3.4, §5.1, M-6)', () => {
  const api = (s = single) => only(s.main, 'AWS::ApiGateway::RestApi');
  const hookRole = `arn:aws:iam::${CONTROL_PLANE_ACCOUNT}:role/demo-fleet-global-hook`;

  it('is a regional REST API from the Smithy OpenAPI with every integration on the registrar function', () => {
    const a = api();
    expect(a.EndpointConfiguration).toEqual({ Types: ['REGIONAL'] });
    const body = JSON.stringify(a.Body);
    expect(body).not.toContain('PLACEHOLDER');
    expect(a.Body.paths['/tenants/{tenantId}'].put['x-amazon-apigateway-request-validator']).toBe('params-only');
    expect(a.Body.security).toEqual([{ 'aws.auth.sigv4': [] }]);
  });

  it('admits only <fleet>-global-hook in the control-plane account and the edge operator role, and denies everyone else (spike S-8)', () => {
    const [allow, deny] = api().Policy.Statement;
    expect(allow).toEqual({
      Sid: 'AdmitHookAndOperator',
      Effect: 'Allow',
      Principal: { AWS: '*' },
      Action: 'execute-api:Invoke',
      Resource: 'execute-api:/*',
      Condition: { ArnLike: { 'aws:PrincipalArn': [hookRole, OPERATOR_ROLE_ARN] } },
    });
    expect(deny).toEqual({
      Sid: 'DenyEveryOtherPrincipal',
      Effect: 'Deny',
      Principal: { AWS: '*' },
      Action: 'execute-api:Invoke',
      Resource: 'execute-api:/*',
      Condition: { ArnNotLike: { 'aws:PrincipalArn': [hookRole, OPERATOR_ROLE_ARN] } },
    });
    expect(api().Policy.Statement).toHaveLength(2);
  });

  it('logs the caller and its account on the stage, never a body, and throttles it', () => {
    const stage = only(single.main, 'AWS::ApiGateway::Stage');
    expect(stage.StageName).toBe(REGISTRAR_STAGE);
    const format = JSON.parse(stage.AccessLogSetting.Format);
    expect(format).toMatchObject({ callerArn: '$context.identity.userArn', callerAccount: '$context.identity.accountId' });
    expect(stage.MethodSettings).toEqual([expect.objectContaining({ DataTraceEnabled: false, LoggingLevel: 'ERROR', ThrottlingRateLimit: 10, ThrottlingBurstLimit: 100 })]);
  });

  it('runs the function with every REGISTRAR_ENV variable and a 30 s timeout (§3.4)', () => {
    const fn = Object.values(single.main.findResources('AWS::Lambda::Function'))
      .find((f) => f.Properties.Environment?.Variables?.[REGISTRAR_ENV.routeTableArn] !== undefined)!.Properties;
    expect(fn.Timeout).toBe(30);
    expect(Object.keys(fn.Environment.Variables).sort()).toEqual(Object.values(REGISTRAR_ENV).sort());
    expect(fn.Environment.Variables).toMatchObject({
      [REGISTRAR_ENV.appDomain]: 'app.example.com',
      [REGISTRAR_ENV.addressing]: 'single',
      [REGISTRAR_ENV.applicationId]: 'demo-app',
      [REGISTRAR_ENV.controlPlaneUrl]: 'https://control-plane.example.com/prod',
      [REGISTRAR_ENV.controlPlaneAccount]: CONTROL_PLANE_ACCOUNT,
      [REGISTRAR_ENV.controlPlaneRegion]: 'eu-central-1',
      [REGISTRAR_ENV.vendorIdpClientId]: 'registrar-client',
      [REGISTRAR_ENV.fleet]: 'demo-fleet',
      [REGISTRAR_ENV.edgeOperatorRoleArn]: OPERATOR_ROLE_ARN,
      [REGISTRAR_ENV.dedicatedDomains]: 'off',
    });
  });

  it('holds the route table writes and the client secret read, and no CloudFront or ACM action while dedicatedDomains is off (§3.4, M-16)', () => {
    const statements = policyStatements(single, 'RegistrarFunction');
    const actions = statements.flatMap((s) => [s.Action].flat());
    expect(statements.find((s) => s.Sid === 'RouteTable')).toMatchObject({
      Action: [
        'cloudfront-keyvaluestore:DescribeKeyValueStore',
        'cloudfront-keyvaluestore:GetKey',
        'cloudfront-keyvaluestore:UpdateKeys',
      ],
      Resource: { 'Fn::GetAtt': [expect.stringMatching(/^RouteTable/), 'Arn'] },
    });
    // The registrar writes only with UpdateKeys under the ETag (S3 route-store.ts).
    expect(actions).not.toContain('cloudfront-keyvaluestore:PutKey');
    expect(actions).not.toContain('cloudfront-keyvaluestore:DeleteKey');
    expect(statements.find((s) => s.Sid === 'VendorIdpClientSecret')).toMatchObject({
      Action: 'secretsmanager:GetSecretValue',
      Resource: BASE_PROPS.controlPlane.vendorIdp.clientSecretArn,
    });
    expect(actions.filter((a) => /^(cloudfront|acm):/.test(a))).toEqual([]);
    expect(actions).not.toContain('cloudfront-keyvaluestore:ListKeys');
  });
});

describe('main stack: published parameter (spec §6.4)', () => {
  it('writes the EdgeParameter JSON at PARAM_EDGE', () => {
    const p = only(single.main, 'AWS::SSM::Parameter');
    expect(p.Name).toBe(PARAM_EDGE);
    const value = JSON.stringify(p.Value);
    for (const field of ['"version\\":1', 'appDomain\\":\\"app.example.com', 'addressing\\":\\"single', 'applicationId\\":\\"demo-app',
      'distributionArn', 'registrarUrl', 'tenantClaim\\":\\"tenant_id', `reservedLabels\\":${JSON.stringify(JSON.stringify(RESERVED_LABELS)).slice(1, -1)}`]) {
      expect(value).toContain(field);
    }
  });
});

describe('edge logging stack (spec §3.1, ADR-0010, M-21)', () => {
  it('delivers the distribution\'s access logs to a log group in us-east-1', () => {
    single.logging.hasResourceProperties('AWS::Logs::DeliverySource', { LogType: 'ACCESS_LOGS' });
    single.logging.hasResourceProperties('AWS::Logs::DeliveryDestination', { OutputFormat: 'json' });
    single.logging.resourceCountIs('AWS::Logs::LogGroup', 1);
  });

  it('names exactly the ADR-0010 record fields and none of cs-uri-query, cs(Referer), cs(Cookie)', () => {
    const fields = only(single.logging, 'AWS::Logs::Delivery').RecordFields;
    expect(fields).toEqual([
      'timestamp(ms)', 'x-edge-location', 'x-host-header', 'distribution-tenant-id', 'cs-method', 'cs-uri-stem', 'sc-status',
      'sc-bytes', 'time-taken', 'x-edge-result-type', 'x-edge-request-id', 'cs-protocol', 'ssl-protocol', 'viewer-request-log-data',
    ]);
    expect(fields).toEqual([...ACCESS_LOG_FIELDS]);
    for (const forbidden of FORBIDDEN_LOG_FIELDS) {
      expect(fields).not.toContain(forbidden);
    }
  });
});
