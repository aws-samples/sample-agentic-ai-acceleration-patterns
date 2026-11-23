// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The integration test's CDK app (test/integ/stacks.ts) synthesises with
 * placeholder inputs under cdk-nag, in both modes and in every phase the
 * driver runs, and its test-only roles hold what spec §6.1 and §10 name.
 */

import * as fs from 'node:fs';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { integNames, IntegInputs, parseIntegInputs, TestRoleInputs } from './inputs';
import { buildIntegApp, stageSource } from './stacks';
import { Addressing } from '../../src/shared/contracts';

const EDGE = '111111111111';
const CP = '222222222222';
const R = 'eu-central-1';
const RUN = 'r0placeh';

const BASE: IntegInputs = {
  runId: RUN,
  edgeAccount: EDGE,
  controlPlaneAccount: CP,
  region: R,
  driverPrincipalArn: `arn:aws:iam::${EDGE}:role/integ-driver`,
  appDomain: 'app.integ-placeholder.example.com',
  hostedZoneId: 'ZPLACEHOLDER0',
  zoneName: 'integ-placeholder.example.com',
  dedicatedDomain: 'dd.integ-placeholder.example.com',
  identity: { userPoolId: `${R}_Placehold`, appClientId: 'placeholderclient', region: R },
  spaSource: `${__dirname}/../edge/fixtures/spa`,
};

const TEST_ROLE: TestRoleInputs = {
  distributionId: 'EPLACEHOLDER',
  routeTableArn: `arn:aws:cloudfront::${EDGE}:key-value-store/00000000-0000-0000-0000-000000000000`,
  routerFunctionArn: `arn:aws:cloudfront::${EDGE}:function/placeholder-router`,
  registrarLogGroupArn: `arn:aws:logs:${R}:${EDGE}:log-group:registrar:*`,
  registrarAccessLogGroupArn: `arn:aws:logs:${R}:${EDGE}:log-group:registrar-access:*`,
  edgeLogGroupArn: `arn:aws:logs:us-east-1:${EDGE}:log-group:edge:*`,
  agentIngressLogGroupArn: `arn:aws:logs:${R}:${EDGE}:log-group:ingress:*`,
  cellLogGroupArn: `arn:aws:logs:${R}:${EDGE}:log-group:cell-b:*`,
  sweeperFunctionArn: `arn:aws:lambda:${R}:${EDGE}:function:sweeper`,
  sweeperTableArn: `arn:aws:dynamodb:${R}:${EDGE}:table/sweeper`,
  sweeperLogGroupArn: `arn:aws:logs:${R}:${EDGE}:log-group:sweeper:*`,
};

const FULL: IntegInputs = {
  ...BASE,
  vendorIdp: {
    tokenUrl: 'https://vendor.integ-placeholder.example.com/oauth2/token',
    clientId: 'placeholderreader',
    clientSecretArn: `arn:aws:secretsmanager:${R}:${EDGE}:secret:placeholder-AAAAAA`, // pragma: allowlist secret
  },
  controlPlaneApiUrl: 'https://cp.integ-placeholder.example.com/prod/',
  agentIngressUrl: 'https://0000000000.execute-api.eu-central-1.amazonaws.com/prod',
  registrarUrl: 'https://1111111111.execute-api.eu-central-1.amazonaws.com/v1/',
  distributionArn: `arn:aws:cloudfront::${EDGE}:distribution/EPLACEHOLDER`,
  testRole: TEST_ROLE,
};

/** Synthesises the app; a cdk-nag error fails the synth. */
function synth(inputs: IntegInputs, addressing: Addressing = 'single'): { app: App; stacks: Stack[] } {
  const app = new App({ context: { 'integ': JSON.stringify(inputs), 'aws:cdk:bundling-stacks': [] } });
  buildIntegApp(app, addressing);
  app.synth();
  const stacks: Stack[] = [];
  const walk = (node: { node: { children: readonly unknown[] } }) => {
    for (const c of node.node.children) {
      if (Stack.isStack(c)) stacks.push(c);
      walk(c as never);
    }
  };
  walk(app);
  return { app, stacks };
}

const names = integNames(RUN);
const byName = (stacks: Stack[], name: string) => {
  const s = stacks.find((x) => x.stackName === name);
  if (s === undefined) throw new Error(`no stack ${name}`);
  return Template.fromStack(s);
};

describe('the integ app', () => {
  jest.setTimeout(240_000);

  it('synthesises the first phase alone: support, control plane setup, agent ingress', () => {
    const { stacks } = synth(BASE);
    expect(stacks.map((s) => s.stackName).sort()).toEqual([names.stacks.agentIngress, names.stacks.controlPlaneSetup, names.stacks.support].sort());
  });

  it.each(['single', 'host'] as const)('synthesises every stack under cdk-nag in %s mode, each with the run prefix', (mode) => {
    const { stacks } = synth(FULL, mode);
    const got = stacks.map((s) => s.stackName).sort();
    expect(got).toEqual([
      names.stacks.support, names.stacks.controlPlaneSetup, names.stacks.agentIngress, names.stacks.edge, names.stacks.main,
      names.stacks.edgeLogging, names.stacks.routeHookAccess, names.stacks.cellA, names.stacks.cellB, names.stacks.testRole,
    ].sort());
    for (const s of got) expect(s.startsWith(`TfdInteg-${RUN}-`)).toBe(true);
    const accounts = Object.fromEntries(stacks.map((s) => [s.stackName, s.account]));
    expect(accounts[names.stacks.cellA]).toBe(CP);
    expect(accounts[names.stacks.routeHookAccess]).toBe(CP);
    expect(accounts[names.stacks.controlPlaneSetup]).toBe(CP);
    expect(accounts[names.stacks.cellB]).toBe(EDGE);
    expect(accounts[names.stacks.main]).toBe(EDGE);
  });

  it('takes host mode\'s lowered rates, with the per-IP rule raised above the per-host one for step 17', () => {
    const { stacks } = synth({ ...FULL, tenantRequestsPer5Min: 100, ipRequestsPer5Min: 1000 }, 'host');
    const doc = JSON.stringify(byName(stacks, names.stacks.edge).toJSON());
    expect(doc).toContain('"Limit":100');
    expect(doc).toContain('"Limit":1000');
  });

  it('drops the sweeper outputs and grants once dedicatedDomains is off (step 14)', () => {
    const testRole = { ...TEST_ROLE, sweeperFunctionArn: undefined, sweeperTableArn: undefined, sweeperLogGroupArn: undefined };
    const { stacks } = synth({ ...FULL, dedicatedDomains: false, testRole });
    const main = byName(stacks, names.stacks.main).toJSON() as { Outputs: Record<string, unknown> };
    expect(Object.keys(main.Outputs).filter((k) => k.startsWith('IntegSweeper'))).toEqual([]);
    const role = JSON.stringify(byName(stacks, names.stacks.testRole).toJSON());
    expect(role).not.toContain('dynamodb:PutItem');
  });

  it('trusts the driver principal alone, in every test role', () => {
    const { stacks } = synth(FULL);
    for (const stack of [names.stacks.support, names.stacks.controlPlaneSetup, names.stacks.testRole]) {
      const roles = byName(stacks, stack).findResources('AWS::IAM::Role', { Properties: { RoleName: Match.stringLikeRegexp(`^TfdInteg-${RUN}-`) } });
      expect(Object.keys(roles).length).toBeGreaterThan(0);
      for (const r of Object.values(roles) as { Properties: { AssumeRolePolicyDocument: unknown } }[]) {
        expect(r.Properties.AssumeRolePolicyDocument).toEqual({
          Version: '2012-10-17',
          Statement: [{
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Principal: { AWS: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:iam::${EDGE}:root`]] } },
            Condition: { ArnEquals: { 'aws:PrincipalArn': BASE.driverPrincipalArn } },
          }],
        });
      }
    }
  });

  it('holds the test role to the challenge name, TXT records and this distribution\'s certificates (spec §10 step 14)', () => {
    const { stacks } = synth(FULL);
    const t = byName(stacks, names.stacks.testRole);
    const doc = JSON.stringify(t.toJSON());
    expect(doc).toContain('"route53:ChangeResourceRecordSetsNormalizedRecordNames":["_tfd-challenge.dd.integ-placeholder.example.com"]');
    expect(doc).toContain('"route53:ChangeResourceRecordSetsRecordTypes":["TXT"]');
    expect(doc).toContain('"aws:ResourceTag/tenant-front-door:distribution":"EPLACEHOLDER"');
    expect(doc).toContain('"aws:RequestTag/tenant-front-door:distribution":"EPLACEHOLDER"');
    for (const action of ['cloudfront-keyvaluestore:PutKey', 'cloudfront:TestFunction', 'lambda:InvokeFunction', 'dynamodb:PutItem', 'logs:FilterLogEvents']) {
      expect(doc).toContain(action);
    }
    expect(doc).not.toMatch(/"Action":"\*"|"cloudfront:\*"|"route53:\*"|"iam:[A-Z]|"sts:AssumeRole"\]/);
  });

  it('lets only the control plane\'s two build roles and its global hook role read the source', () => {
    const { stacks } = synth(FULL);
    const policy = byName(stacks, names.stacks.controlPlaneSetup).findResources('AWS::S3::BucketPolicy');
    const doc = JSON.stringify(policy);
    for (const role of ['cell-build', 'tenant-build', 'global-hook']) expect(doc).toContain(`arn:aws:iam::${CP}:role/${names.fleet}-${role}`);
    expect(doc).toContain(`"aws:PrincipalAccount":"${CP}"`);
  });

  it('lets the driver access role read only this run\'s tenant namespaces and the cells\' probe parameters', () => {
    const { stacks } = synth(BASE);
    const policies = byName(stacks, names.stacks.controlPlaneSetup).findResources('AWS::IAM::Policy');
    type Statement = { Sid?: string; Resource: unknown };
    const statements = Object.values(policies).flatMap((p) => (p as { Properties: { PolicyDocument: { Statement: Statement[] } } })
      .Properties.PolicyDocument.Statement);
    const read = statements.find((s) => s.Sid === 'ReadRunParameters');
    const resources = JSON.stringify(read?.Resource);
    expect(resources).toContain(`:parameter/application-plane/tenants/*/${names.applicationId}"`);
    expect(resources).toContain(`:parameter/application-plane/tenants/*/${names.applicationId}/*"`);
    expect(resources).toContain(':parameter/application-plane/cells/*/registrar-probe"');
    const all = JSON.stringify(statements);
    expect(all).not.toMatch(/:parameter\/application-plane\/\*"/);
    expect(all).not.toMatch(/:parameter\/application-plane"/);
  });

  it('serves the stand-in agent route only behind its token check', () => {
    const { stacks } = synth(FULL);
    const t = byName(stacks, names.stacks.agentIngress);
    const methods = t.findResources('AWS::ApiGateway::Method');
    expect(Object.values(methods).map((m) => (m as { Properties: { AuthorizationType: string; HttpMethod: string } }).Properties))
      .toEqual([expect.objectContaining({ AuthorizationType: 'CUSTOM', HttpMethod: 'POST' })]);
    t.hasResourceProperties('AWS::ApiGateway::Method', { Integration: Match.objectLike({ ResponseTransferMode: 'STREAM' }) });
  });
});

describe('the integ inputs', () => {
  it('refuses a missing context, one account for both, a dedicated domain inside appDomain and a principal of another account', () => {
    expect(() => parseIntegInputs(undefined)).toThrow(/Missing the integ context/);
    expect(() => parseIntegInputs({ ...BASE, controlPlaneAccount: EDGE })).toThrow(/must differ/);
    expect(() => parseIntegInputs({ ...BASE, dedicatedDomain: 'dd.app.integ-placeholder.example.com' })).toThrow(/outside appDomain/);
    expect(() => parseIntegInputs({ ...BASE, appDomain: 'app.other.example.com' })).toThrow(/below the zone/);
    expect(() => parseIntegInputs({ ...BASE, driverPrincipalArn: `arn:aws:iam::${CP}:role/x` })).toThrow(/in the edge account/);
    expect(() => parseIntegInputs({ ...BASE, runId: 'awsx' })).toThrow(/runId/);
    expect(parseIntegInputs(JSON.stringify(BASE)).appDomain).toBe(BASE.appDomain);
  });

  it('stages the hook and application scripts at their repository paths', () => {
    const dir = stageSource();
    for (const f of ['hooks/route-hook.sh', 'test/integ/hooks/probe-hook.sh', 'test/integ/app/cell/create.sh', 'test/integ/app/tenant/update.sh', 'test/integ/app/shared/registrar.sh']) {
      expect(fs.existsSync(`${dir}/samples/tenant-front-door/${f}`)).toBe(true);
    }
  });
});
