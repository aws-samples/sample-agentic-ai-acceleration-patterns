// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The entitlement API's routes (spec §5.3, C-14) on a REST API the ingress
 * owns: the `api-gateway` ingress's own API, or the small issuer API beside
 * the AgentCore Gateway. Two functions, one per door, with asymmetric roles
 * (standard §4.3, M-44, M-45):
 *
 * - `VendorFunction`, routes under IAM auth: writes `TENANT#*` and `PLAN#*`
 *   rows, reads the catalogue and reservations;
 * - `TenantAdminFunction`, routes with no API Gateway authoriser (the
 *   function verifies the identity token and the admin scope itself): reads
 *   plans and the catalogue, and may assume `TenantAdminRole`, whose item
 *   calls are limited to `TENANT#${aws:PrincipalTag/TenantId}`.
 *
 * The routes follow the Smithy model's `@http` traits; the generated
 * OpenAPI document (src/smithy/entitlements/openapi) is the reference.
 */

import * as path from 'node:path';
import { Duration, Validations } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import { ENTITLEMENTS_ENV } from './entitlements.function';
import { ENV } from '../shared/config';
import type { EntitlementStore } from '../shared/entitlement-store.cdk';
import { acknowledgeLambdaFindings, functionProps } from '../shared/function.cdk';
import type { LogDrain } from '../shared/log-drain';
import { TENANT_TAG_KEY } from '../shared/tvm';

export interface EntitlementApiProps {
  readonly api: apigateway.RestApi;
  readonly store: EntitlementStore;
  readonly discoveryUrl: string;
  readonly allowedClientIds: string[];
  readonly multiTenant: boolean;
  readonly adminScope: string;
  /** The ingress's own issuer: refused as an identity issuer (P-14). */
  readonly issuer: string;
  readonly logDrain?: LogDrain;
}

export class EntitlementApi extends Construct {
  readonly vendorFunction: NodejsFunction;
  readonly tenantAdminFunction: NodejsFunction;
  /** The role the tenant-admin side assumes per request with the caller's `TenantId` (M-45). */
  readonly tenantAdminRole: iam.Role;

  constructor(scope: Construct, id: string, props: EntitlementApiProps) {
    super(scope, id);
    const common = {
      [ENV.ENTITLEMENTS_TABLE]: props.store.tableName,
      [ENTITLEMENTS_ENV.MAX_AGENTS]: String(props.store.maxAgentsPerTenant),
      [ENTITLEMENTS_ENV.MAX_TOOLS]: String(props.store.maxToolsPerTenant),
    };
    const entry = path.join(__dirname, 'entitlements.function.ts');

    this.vendorFunction = new NodejsFunction(this, 'VendorFunction', {
      ...functionProps(this, 'VendorLogs', Duration.seconds(29)),
      entry,
      description: 'runtime-isolation: entitlement API, vendor side (SigV4): tenant subscriptions and plans (ADR-0030)',
      environment: { ...common, [ENTITLEMENTS_ENV.SIDE]: 'vendor' },
    });
    acknowledgeLambdaFindings(this.vendorFunction);
    props.store.grantVendorWrite(this.vendorFunction.role!);
    // ListPlans and DeletePlan's plan_in_use check Query the plan index rows (src/shared/entitlements.ts): no Scan.

    this.tenantAdminFunction = new NodejsFunction(this, 'TenantAdminFunction', {
      ...functionProps(this, 'TenantAdminLogs', Duration.seconds(29)),
      entry,
      description: 'runtime-isolation: entitlement API, tenant-admin side (identity token + admin scope): user cuts (ADR-0033)',
      environment: {
        ...common,
        [ENTITLEMENTS_ENV.SIDE]: 'tenant-admin',
        [ENTITLEMENTS_ENV.ADMIN_SCOPE]: props.adminScope,
        [ENV.DISCOVERY_URL]: props.discoveryUrl,
        [ENV.ALLOWED_CLIENT_IDS]: props.allowedClientIds.join(','),
        [ENV.MULTI_TENANT]: String(props.multiTenant),
        [ENV.ISSUER]: props.issuer,
      },
    });
    acknowledgeLambdaFindings(this.tenantAdminFunction);
    props.store.grantCatalogueRead(this.tenantAdminFunction.role!);

    const caller = this.tenantAdminFunction.role!;
    this.tenantAdminRole = new iam.Role(this, 'TenantAdminRole', {
      description: 'Entitlement API tenant-admin role (ADR-0033): assumable only by the tenant-admin function with a TenantId tag; own tenant partition only',
      assumedBy: new iam.ArnPrincipal(caller.roleArn)
        .withConditions({
          'StringLike': { [`aws:RequestTag/${TENANT_TAG_KEY}`]: '?*' },
          'ForAllValues:StringEquals': { 'aws:TagKeys': [TENANT_TAG_KEY] },
        })
        .withSessionTags(),
      maxSessionDuration: Duration.hours(1),
    });
    props.store.grantTenantAdminPartition(this.tenantAdminRole);
    caller.addToPrincipalPolicy(
      new iam.PolicyStatement({ sid: 'AssumeTenantAdminRole', actions: ['sts:AssumeRole', 'sts:TagSession'], resources: [this.tenantAdminRole.roleArn] }),
    );
    this.tenantAdminFunction.addEnvironment(ENTITLEMENTS_ENV.TENANT_ADMIN_ROLE_ARN, this.tenantAdminRole.roleArn);

    // Routes (model/entitlements.smithy).
    const vendor = new apigateway.LambdaIntegration(this.vendorFunction, { proxy: true });
    const admin = new apigateway.LambdaIntegration(this.tenantAdminFunction, { proxy: true });
    const iamAuth: apigateway.MethodOptions = { authorizationType: apigateway.AuthorizationType.IAM };
    const tokenAuth: apigateway.MethodOptions = { authorizationType: apigateway.AuthorizationType.NONE };
    const root = props.api.root.addResource('entitlements');

    const tenant = root.addResource('tenants').addResource('{tenantId}');
    for (const method of ['PUT', 'GET', 'DELETE']) {
      tenant.addMethod(method, vendor, iamAuth);
    }
    const plans = root.addResource('plans');
    plans.addMethod('GET', vendor, iamAuth);
    const plan = plans.addResource('{planName}');
    for (const method of ['PUT', 'GET', 'DELETE']) {
      plan.addMethod(method, vendor, iamAuth);
    }
    const users = root.addResource('users');
    const listCuts = users.addMethod('GET', admin, tokenAuth);
    const cut = users.addResource('{sub}').addResource('cut');
    const cutMethods = ['PUT', 'GET', 'DELETE'].map((method) => cut.addMethod(method, admin, tokenAuth));

    const reason =
      'The tenant-admin routes authenticate in the function: it verifies the identity token with the ingress verifier, requires the admin scope and writes only under credentials tagged with the verified tenant (ADR-0033, M-45).';
    for (const method of [listCuts, ...cutMethods]) {
      Validations.of(method).acknowledge({ id: 'AwsSolutions-APIG4', reason });
      Validations.of(method).acknowledge({ id: 'AwsSolutions-COG4', reason });
    }
    if (props.logDrain !== undefined) {
      props.logDrain.protect(this.vendorFunction.logGroup);
      props.logDrain.protect(this.tenantAdminFunction.logGroup);
    }
  }
}
