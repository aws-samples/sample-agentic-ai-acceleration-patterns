// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The `TenantFrontDoor` construct (spec §6.4): the front door's stacks, in
 * their deploy order (spec §3.1, ADR-0010):
 *
 * 1. `<prefix>-edge`, `us-east-1`: certificate and web ACL;
 * 2. `<prefix>-main`, the control plane's Region: distribution, router,
 *    route table, SPA bucket, registrar, published parameter;
 * 3. `<prefix>-edge-logging`, `us-east-1`: standard logging v2;
 * 4. `<prefix>-route-hook-access`, in the control plane's account and
 *    Region: the hook parameter and the hook policy, once `registrarUrl`
 *    names the deployed registrar.
 *
 * The first three are in the edge account, the account of
 * `edgeOperatorRoleArn`. The values cross Regions through CDK's
 * cross-Region references; nothing crosses to the control plane's account,
 * so the fourth stack takes the registrar URL as an input, read from the
 * edge parameter after the main stack is deployed. Place the construct in
 * an `App` or a `Stage`. It applies no cdk-nag aspect; its
 * acknowledgements travel with it.
 */

import * as path from 'node:path';
import { Construct } from 'constructs';
import { EdgeLoggingStack } from './edge-logging.cdk';
import { EdgeStack } from './edge.cdk';
import { TenantFrontDoorInputs, validateInputs } from './inputs';
import { MainStack, REGISTRAR_STAGE } from './main.cdk';
import { parseRegistrarUrl, RouteHookAccessStack } from '../hooks/route-hook-access.cdk';
import { Addressing } from '../shared/contracts';

/** CloudFront takes certificates and web ACLs from here, and logging v2 runs here (ADR-0010). */
export const EDGE_REGION = 'us-east-1';

export const DEFAULT_ROUTER_SOURCE = path.join(__dirname, '..', 'router', 'router.js');
export const DEFAULT_REGISTRAR_ENTRY = path.join(__dirname, '..', 'registrar', 'registrar.function.ts');

export interface TenantFrontDoorProps extends TenantFrontDoorInputs {
  /** Stack name prefix. Default: the construct id. */
  readonly stackNamePrefix?: string;
  /** The router's source with the `ROUTER_TOKENS` literals. Default `src/router/router.js`. */
  readonly routerSourcePath?: string;
  /** The registrar function's entry. Default `src/registrar/registrar.function.ts`. */
  readonly registrarEntry?: string;
}

export class TenantFrontDoor extends Construct {
  public readonly edgeStack: EdgeStack;
  public readonly mainStack: MainStack;
  public readonly edgeLoggingStack: EdgeLoggingStack;
  /** Present when `registrarUrl` is set. */
  public readonly routeHookAccessStack?: RouteHookAccessStack;

  public readonly distributionId: string;
  public readonly distributionArn: string;
  public readonly routeTableArn: string;
  public readonly registrarUrl: string;
  public readonly appDomain: string;
  public readonly addressing: Addressing;
  /** The pooled distribution tenant's id. */
  public readonly pooledTenantId: string;
  /** The CNAME target of a dedicated domain: the connection group's routing endpoint (spec §6.4). */
  public readonly routingEndpoint: string;

  constructor(scope: Construct, id: string, props: TenantFrontDoorProps) {
    super(scope, id);
    const inputs = validateInputs(props);
    const prefix = props.stackNamePrefix ?? id;
    const account = inputs.edgeAccount;

    this.edgeStack = new EdgeStack(this, 'Edge', {
      stackName: `${prefix}-edge`,
      description: 'Tenant front door edge stack: certificate and web ACL (spec §3.1)',
      env: { account, region: EDGE_REGION },
      crossRegionReferences: true,
      inputs,
    });
    this.mainStack = new MainStack(this, 'Main', {
      stackName: `${prefix}-main`,
      description: 'Tenant front door main stack: distribution, router, route table, registrar (spec §3.1)',
      env: { account, region: inputs.controlPlane.region },
      crossRegionReferences: true,
      inputs,
      certificateArn: this.edgeStack.certificateArn,
      webAclArn: this.edgeStack.webAclArn,
      routerSourcePath: props.routerSourcePath ?? DEFAULT_ROUTER_SOURCE,
      registrarEntry: props.registrarEntry ?? DEFAULT_REGISTRAR_ENTRY,
    });
    this.edgeLoggingStack = new EdgeLoggingStack(this, 'EdgeLogging', {
      stackName: `${prefix}-edge-logging`,
      description: 'Tenant front door edge logging stack: standard logging v2 (spec §3.1, ADR-0010)',
      env: { account, region: EDGE_REGION },
      crossRegionReferences: true,
      distributionArn: this.mainStack.distributionArn,
    });

    if (inputs.registrarUrl !== undefined) {
      if (parseRegistrarUrl(inputs.registrarUrl).stage !== REGISTRAR_STAGE) {
        throw new Error(`tenant-front-door input registrarUrl must name the registrar's stage, /${REGISTRAR_STAGE}/ (spec §3.6)`);
      }
      this.routeHookAccessStack = new RouteHookAccessStack(this, 'RouteHookAccess', {
        stackName: `${prefix}-route-hook-access`,
        description: 'Tenant front door route hook access: the hook parameter and the hook policy, in the control plane\'s account (spec §3.1)',
        env: { account: inputs.controlPlane.accountId, region: inputs.controlPlane.region },
        applicationId: inputs.applicationId,
        registrarUrl: inputs.registrarUrl,
        appDomain: inputs.appDomain,
        addressing: inputs.addressing,
        edgeAccountId: account,
      });
    }

    this.distributionId = this.mainStack.distributionId;
    this.distributionArn = this.mainStack.distributionArn;
    this.routeTableArn = this.mainStack.routeTableArn;
    this.registrarUrl = this.mainStack.registrarUrl;
    this.appDomain = inputs.appDomain;
    this.addressing = inputs.addressing;
    this.pooledTenantId = this.mainStack.pooledTenantId;
    this.routingEndpoint = this.mainStack.routingEndpoint;
  }
}
