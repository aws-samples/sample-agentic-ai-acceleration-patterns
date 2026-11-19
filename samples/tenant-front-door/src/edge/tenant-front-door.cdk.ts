// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The `TenantFrontDoor` construct (spec §6.4): the front door's three edge
 * stacks, in their deploy order (spec §3.1, ADR-0010):
 *
 * 1. `<prefix>-edge`, `us-east-1`: certificate and web ACL;
 * 2. `<prefix>-main`, the control plane's Region: distribution, router,
 *    route table, SPA bucket, registrar, published parameter;
 * 3. `<prefix>-edge-logging`, `us-east-1`: standard logging v2.
 *
 * All three are in the edge account, the account of `edgeOperatorRoleArn`.
 * The values cross Regions through CDK's cross-Region references. Place the
 * construct in an `App` or a `Stage`. It applies no cdk-nag aspect; its
 * acknowledgements travel with it.
 */

import * as path from 'node:path';
import { Construct } from 'constructs';
import { EdgeLoggingStack } from './edge-logging.cdk';
import { EdgeStack } from './edge.cdk';
import { TenantFrontDoorInputs, validateInputs } from './inputs';
import { MainStack } from './main.cdk';
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

  public readonly distributionId: string;
  public readonly distributionArn: string;
  public readonly routeTableArn: string;
  public readonly registrarUrl: string;
  public readonly appDomain: string;
  public readonly addressing: Addressing;
  /** The pooled distribution tenant's id. */
  public readonly pooledTenantId: string;

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

    this.distributionId = this.mainStack.distributionId;
    this.distributionArn = this.mainStack.distributionArn;
    this.routeTableArn = this.mainStack.routeTableArn;
    this.registrarUrl = this.mainStack.registrarUrl;
    this.appDomain = inputs.appDomain;
    this.addressing = inputs.addressing;
    this.pooledTenantId = this.mainStack.pooledTenantId;
  }
}
