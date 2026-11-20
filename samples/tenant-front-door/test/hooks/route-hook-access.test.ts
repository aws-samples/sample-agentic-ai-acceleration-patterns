// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/** The `RouteHookAccess` construct and stack (spec §3.1, §6.4; M-41, M-46). */

import { App, Stack, Token } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { RouteHookAccess, parseRegistrarUrl } from '../../src/hooks/route-hook-access.cdk';
import { paramHook } from '../../src/shared/contracts';
import { BASE_PROPS, CONTROL_PLANE_ACCOUNT, EDGE_ACCOUNT, FULL_HOST_PROPS, only, synth } from '../edge/helpers';

const REGISTRAR = 'https://abcde12345.execute-api.eu-central-1.amazonaws.com/v1/';
const single = synth({ ...BASE_PROPS, registrarUrl: REGISTRAR });
const host = synth({ ...FULL_HOST_PROPS, registrarUrl: REGISTRAR });

function statements(t: Template): Record<string, any>[] {
  return only(t, 'AWS::IAM::ManagedPolicy').PolicyDocument.Statement;
}

describe('RouteHookAccess stack', () => {
  it('is absent until registrarUrl names the deployed registrar', () => {
    const s = synth(BASE_PROPS);
    expect(s.frontDoor.routeHookAccessStack).toBeUndefined();
    expect(s.routeHook).toBeUndefined();
  });

  it('deploys in the control plane\'s account and Region, depending on no edge stack (§3.1)', () => {
    const stack = single.frontDoor.routeHookAccessStack!;
    expect(stack.stackName).toBe('Tfd-route-hook-access');
    expect([stack.account, stack.region]).toEqual([CONTROL_PLANE_ACCOUNT, 'eu-central-1']);
    expect(stack.dependencies).toEqual([]);
  });

  it('writes the hook parameter under its own name as one JSON document, kept on delete and replace (M-46)', () => {
    const resources = single.routeHook!.findResources('AWS::SSM::Parameter');
    const [resource] = Object.values(resources);
    expect(Object.keys(resources)).toHaveLength(1);
    expect(resource.DeletionPolicy).toBe('Retain');
    expect(resource.UpdateReplacePolicy).toBe('Retain');
    expect(resource.Properties.Name).toBe(paramHook('demo-app'));
    expect(resource.Properties.Type).toBe('String');
    expect(JSON.parse(resource.Properties.Value)).toEqual({
      version: 1, registrarUrl: REGISTRAR, appDomain: 'app.example.com', addressing: 'single',
    });
    const hostValue = only(host.routeHook!, 'AWS::SSM::Parameter').Value;
    expect(JSON.parse(hostValue).addressing).toBe('host');
  });

  it('holds a named customer-managed policy: every hook parameter, and only this registrar\'s hook routes (ADR-0017)', () => {
    const policy = only(single.routeHook!, 'AWS::IAM::ManagedPolicy');
    expect(policy.ManagedPolicyName).toBe('tenant-front-door-route-hook-demo-app');
    expect(policy.Roles).toBeUndefined();
    const [read, invoke] = statements(single.routeHook!);
    expect(read).toEqual({
      Sid: 'ReadFrontDoorHookParameters',
      Effect: 'Allow',
      Action: 'ssm:GetParameter',
      Resource: {
        'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:ssm:eu-central-1:${CONTROL_PLANE_ACCOUNT}:parameter/application-plane/applications/*/shared/front-door-hook`]],
      },
    });
    expect(invoke.Sid).toBe('InvokeRegistrarRoutes');
    expect(invoke.Action).toBe('execute-api:Invoke');
    const arns = invoke.Resource.map((r: any) => r['Fn::Join'][1].map((p: any) => (typeof p === 'string' ? p : '<p>')).join(''));
    expect(arns).toEqual(['PUT/cells/*', 'DELETE/cells/*', 'PUT/tenants/*', 'DELETE/tenants/*'].map(
      (route) => `arn:<p>:execute-api:eu-central-1:${EDGE_ACCOUNT}:abcde12345/v1/${route}`,
    ));
  });

  it('grants nothing on the control plane\'s own resources and no write at all', () => {
    const actions = statements(single.routeHook!).flatMap((s) => [s.Action].flat());
    expect(actions).toEqual(['ssm:GetParameter', 'execute-api:Invoke']);
  });

  it('outputs the policy ARN for globalHookManagedPolicyArns and the parameter name', () => {
    const outputs = single.routeHook!.toJSON().Outputs;
    expect(outputs.RouteHookPolicyArn.Value).toEqual({ Ref: expect.stringMatching(/^RouteHookAccessPolicy/) });
    expect(outputs.HookParameterName.Value).toBe(paramHook('demo-app'));
  });

  it('passes cdk-nag AwsSolutionsChecks with its own acknowledgements (standard §4.3)', () => {
    expect(() => synth({ ...BASE_PROPS, registrarUrl: REGISTRAR }, true)).not.toThrow();
    expect(() => synth({ ...FULL_HOST_PROPS, registrarUrl: REGISTRAR }, true)).not.toThrow();
  });
});

describe('registrarUrl input (§3.6)', () => {
  it.each([
    ['a URL outside API Gateway', 'https://registrar.example.com/v1/', /registrarUrl must be the registrar's stage URL/],
    ['no trailing slash', REGISTRAR.slice(0, -1), /registrarUrl must be the registrar's stage URL/],
    ['a deeper path', `${REGISTRAR}tenants/`, /registrarUrl must be the registrar's stage URL/],
    ['another Region', 'https://abcde12345.execute-api.us-east-1.amazonaws.com/v1/', /control plane's Region/],
    ['another stage', 'https://abcde12345.execute-api.eu-central-1.amazonaws.com/prod/', /\/v1\//],
  ])('refuses %s', (_name, registrarUrl, error) => {
    expect(() => synth({ ...BASE_PROPS, registrarUrl })).toThrow(error);
  });
});

describe('RouteHookAccess construct', () => {
  const props = { applicationId: 'demo-app', registrarUrl: REGISTRAR, appDomain: 'app.example.com', addressing: 'single' as const, edgeAccountId: EDGE_ACCOUNT };

  it('needs a stack with a concrete account and Region', () => {
    expect(() => new RouteHookAccess(new Stack(new App(), 'S'), 'A', props)).toThrow(/concrete account and Region/);
  });

  it.each([
    [{ registrarUrl: 'https://abcde12345.execute-api.us-east-1.amazonaws.com/v1/' }, /not the control plane's Region/],
    [{ applicationId: 'Demo' }, /applicationId/],
    [{ edgeAccountId: '1234' }, /edgeAccountId/],
    [{ addressing: 'path' as never }, /addressing/],
  ])('refuses %j', (patch, error) => {
    const stack = new Stack(new App(), 'S', { env: { account: CONTROL_PLANE_ACCOUNT, region: 'eu-central-1' } });
    expect(() => new RouteHookAccess(stack, 'A', { ...props, ...patch })).toThrow(error);
  });

  it('refuses a registrar URL token, which a stack in another account cannot resolve', () => {
    const stack = new Stack(new App(), 'S', { env: { account: CONTROL_PLANE_ACCOUNT, region: 'eu-central-1' } });
    expect(() => new RouteHookAccess(stack, 'A', { ...props, registrarUrl: Token.asString({ Ref: 'RegistrarUrl' }) })).toThrow(/literal/);
  });

  it('parses a registrar stage URL', () => {
    expect(parseRegistrarUrl(REGISTRAR)).toEqual({ apiId: 'abcde12345', region: 'eu-central-1', stage: 'v1' });
    expect(parseRegistrarUrl('https://abcde12345.execute-api.cn-north-1.amazonaws.com.cn/v1/').region).toBe('cn-north-1');
  });
});
