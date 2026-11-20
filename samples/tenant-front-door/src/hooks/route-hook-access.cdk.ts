// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The `RouteHookAccess` construct and stack (spec §3.1, §6.4, ADR-0017), in
 * the control plane's account and Region:
 *
 * - the front door hook parameter
 *   `/application-plane/applications/<applicationId>/shared/front-door-hook`,
 *   one JSON document (`HookParameter`), kept when the stack is deleted or
 *   the parameter replaced (M-46);
 * - a customer-managed policy the deployer lists in the control plane's
 *   `globalHookManagedPolicyArns` (control-plane R-41), which lets
 *   `<fleet>-global-hook` read every front door hook parameter and invoke
 *   this front door's registrar routes the route hook calls.
 */

import { CfnOutput, RemovalPolicy, Stack, StackProps, Token } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { acknowledge, nagFindingResource } from '../edge/nag';
import { Addressing, HookParameter, paramHook, REGISTRAR_URL } from '../shared/contracts';

/** The registrar routes the route hook calls (spec §3.2): puts and deletes of cell and tenant routes. */
export const ROUTE_HOOK_ROUTES: readonly string[] = ['PUT/cells/*', 'DELETE/cells/*', 'PUT/tenants/*', 'DELETE/tenants/*'];

/** Every front door's hook parameter, which the shared hook role reads. */
export const HOOK_PARAMETER_PATTERN = 'application-plane/applications/*/shared/front-door-hook';

export interface RouteHookAccessProps {
  /** The control-plane application this front door serves. */
  readonly applicationId: string;
  /** The deployed registrar's stage URL: the edge parameter's `registrarUrl` (§6.4). A literal, read after the main stack is deployed. */
  readonly registrarUrl: string;
  readonly appDomain: string;
  readonly addressing: Addressing;
  /** The edge account, which holds the registrar. */
  readonly edgeAccountId: string;
}

/** The parsed parts of a registrar stage URL. */
export interface RegistrarUrlParts {
  readonly apiId: string;
  readonly region: string;
  readonly stage: string;
}

/** Parses a registrar stage URL, or throws naming the form it needs. */
export function parseRegistrarUrl(url: string): RegistrarUrlParts {
  const m = REGISTRAR_URL.exec(url);
  if (m === null) {
    throw new Error(`registrarUrl must be the registrar's stage URL, https://<api id>.execute-api.<region>.amazonaws.com/<stage>/ (spec §6.4), got ${url}`);
  }
  return { apiId: m[1], region: m[2], stage: m[3] };
}

/** The hook parameter and the hook policy (spec §3.1). Place it in a stack with a concrete account and Region. */
export class RouteHookAccess extends Construct {
  public readonly parameterName: string;
  public readonly policy: iam.ManagedPolicy;

  constructor(scope: Construct, id: string, props: RouteHookAccessProps) {
    super(scope, id);
    const stack = Stack.of(this);
    if (Token.isUnresolved(stack.account) || Token.isUnresolved(stack.region)) {
      throw new Error('RouteHookAccess needs a stack with a concrete account and Region: the control plane\'s');
    }
    if (Token.isUnresolved(props.registrarUrl)) {
      throw new Error('RouteHookAccess needs registrarUrl as a literal: it is in the edge account, which a stack here cannot reference');
    }
    if (!/^[a-z0-9-]{1,32}$/.test(props.applicationId)) {
      throw new Error('RouteHookAccess applicationId must match [a-z0-9-]{1,32}');
    }
    if (!/^\d{12}$/.test(props.edgeAccountId)) {
      throw new Error('RouteHookAccess edgeAccountId must be 12 digits');
    }
    if (props.addressing !== 'single' && props.addressing !== 'host') {
      throw new Error('RouteHookAccess addressing must be "single" or "host"');
    }
    const registrar = parseRegistrarUrl(props.registrarUrl);
    if (registrar.region !== stack.region) {
      // The main stack, and so the registrar, deploys in the control plane's Region (§3.1).
      throw new Error(`RouteHookAccess registrarUrl is in ${registrar.region}, not the control plane's Region ${stack.region}`);
    }

    this.parameterName = paramHook(props.applicationId);
    const value: HookParameter = {
      version: 1,
      registrarUrl: props.registrarUrl,
      appDomain: props.appDomain,
      addressing: props.addressing,
    };
    const parameter = new ssm.StringParameter(this, 'Parameter', {
      parameterName: this.parameterName,
      stringValue: JSON.stringify(value),
      description: `Tenant front door route hook: the registrar of application ${props.applicationId} (spec §3.1)`,
    });
    // Kept on stack delete and on replacement, so only a deliberate
    // deletion makes the hook skip the application (M-46, T-63).
    parameter.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const invokeResources = ROUTE_HOOK_ROUTES.map(
      (route) => `arn:${stack.partition}:execute-api:${registrar.region}:${props.edgeAccountId}:${registrar.apiId}/${registrar.stage}/${route}`,
    );
    const parameterResource = stack.formatArn({ service: 'ssm', resource: 'parameter', resourceName: HOOK_PARAMETER_PATTERN });
    this.policy = new iam.ManagedPolicy(this, 'Policy', {
      managedPolicyName: `tenant-front-door-route-hook-${props.applicationId}`,
      description: `Tenant front door route hook for ${props.applicationId}: add to the control plane's globalHookManagedPolicyArns (spec §3.1)`,
      statements: [
        new iam.PolicyStatement({
          sid: 'ReadFrontDoorHookParameters',
          actions: ['ssm:GetParameter'],
          resources: [parameterResource],
        }),
        new iam.PolicyStatement({
          sid: 'InvokeRegistrarRoutes',
          actions: ['execute-api:Invoke'],
          resources: invokeResources,
        }),
      ],
    });
    acknowledge(
      this.policy,
      `AwsSolutions-IAM5[Resource::${nagFindingResource(this, parameterResource)}]`,
      'The route hook is one pair of global hooks for every front door on the control plane, so the shared hook role reads each '
      + 'application\'s front door hook parameter, and only those, by one name pattern (ADR-0014, ADR-0017, M-41).',
    );
    for (const resource of invokeResources) {
      acknowledge(
        this.policy,
        `AwsSolutions-IAM5[Resource::${nagFindingResource(this, resource)}]`,
        'One registrar route per cell or tenant id, which the registrar checks against the control plane on every call; '
        + 'the wildcard is the id path segment (ADR-0017, M-6, M-7).',
      );
    }
  }
}

export interface RouteHookAccessStackProps extends StackProps, RouteHookAccessProps {}

/** `RouteHookAccess` as a stack of its own, in the control plane's account and Region (spec §3.1). */
export class RouteHookAccessStack extends Stack {
  public readonly access: RouteHookAccess;

  constructor(scope: Construct, id: string, props: RouteHookAccessStackProps) {
    super(scope, id, props);
    this.access = new RouteHookAccess(this, 'RouteHookAccess', props);
    new CfnOutput(this, 'RouteHookPolicyArn', {
      value: this.access.policy.managedPolicyArn,
      description: 'Add to the control plane\'s globalHookManagedPolicyArns, then update the control plane (spec §6.1)',
    });
    new CfnOutput(this, 'HookParameterName', {
      value: this.access.parameterName,
      description: 'Kept when this stack is deleted; delete it after the stack in the teardown (spec §6.2)',
    });
  }
}
