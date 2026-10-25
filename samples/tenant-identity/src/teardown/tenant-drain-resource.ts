// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CustomResource } from 'aws-cdk-lib';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct, IConstruct } from 'constructs';

/**
 * The teardown custom resource (ADR-0022). It wraps the drain handler as a
 * `Custom::TenantDrain` resource so that, on `cdk destroy`, the handler runs
 * before CloudFormation deletes the registry table and the shared pool —
 * draining every tenant (and, in pool-per-tenant, its runtime-created pool)
 * that the table would otherwise orphan.
 *
 * Deletion order is the point. `dependsOn(x)` makes this resource depend on
 * `x`, so CloudFormation deletes this resource — i.e. runs the drain — before
 * it deletes `x`. The coordinator calls `dependsOn` for the registry table
 * and the shared pool in identity.cdk.ts.
 *
 * IAM is deliberately not here (sibling of LogDrain): the handler's role is
 * granted its registry and Cognito actions in identity.cdk.ts, where the
 * topology and the resources are known.
 */
export class TenantDrain extends Construct {
  /** The underlying custom resource; exposed so the stack can wire ordering. */
  public readonly resource: CustomResource;

  constructor(scope: Construct, id: string, props: { readonly handler: lambda.IFunction }) {
    super(scope, id);
    this.resource = new CustomResource(this, 'Resource', {
      serviceToken: props.handler.functionArn,
      resourceType: 'Custom::TenantDrain',
    });
  }

  /**
   * The drain is deleted (runs) before `construct` is deleted. Used for the
   * registry table and the shared pool, so neither is torn down until every
   * tenant has been offboarded (ADR-0022).
   */
  public dependsOn(construct: IConstruct): void {
    this.resource.node.addDependency(construct);
  }
}
