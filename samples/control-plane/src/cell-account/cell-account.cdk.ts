// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Annotations, CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import {
  apiRoleArn,
  buildRoleArn,
  DEFAULT_FLEET_NAME,
  ProvisioningRoleKind,
  provisioningRoleName,
  sessionTagConditions,
  sessionTagRequestConditions,
  validateExternalId,
  validateFleetName,
} from '../shared/fleet';
import { suppressTemplateScanners } from '../shared/nag';
import {
  acknowledgeSsmNamespaceGrant,
  acknowledgeTaggedSsmGrant,
  manageCellNamespaceStatement,
  manageTenantNamespaceStatement,
  OWN_CELL_PATH,
  OWN_DEPLOYMENT_PATH,
  readCellNamespaceStatement,
  readSharedResourcesStatement,
} from '../shared/ssm-namespaces';
import {
  stackIdentity,
  StackIdentity,
  validateCellBuildManagedPolicyArns,
  validateTenantBuildManagedPolicyArns,
} from '../tenant/validation';

export interface CellAccountRolesProps {
  /** The account the control plane stack runs in — the only principal the pair trusts. */
  readonly controlPlaneAccountId: string;
  /** Names the pair and the build roles it trusts (spec §3.3). Default `control-plane`. */
  readonly fleetName?: string;
  /**
   * When set, both trust policies require `sts:ExternalId` to equal it and
   * the operator supplies the same value at `PutAccount` (spec §6.4, M19).
   * Required for tenant-owned accounts — `PutAccount` refuses an
   * `owner: TENANT` registration without one (ADR-029); optional for
   * vendor-owned ones. Validated against STS's pattern at synth.
   */
  readonly externalId?: string;
  /**
   * Customer-managed IAM policy ARNs in THIS account, attached to the tenant
   * provisioning role in addition to its namespace grants (ADR-022 as
   * narrowed by ADR-025: the account owner widens their own role, never the
   * control plane). Validated to be in this stack's partition and account.
   */
  readonly tenantBuildManagedPolicyArns?: string[];
  /**
   * Customer-managed IAM policy ARNs in THIS account, attached to the cell
   * provisioning role in addition to its namespace grants (ADR-0047), for a
   * cell script that deploys with a tool the owner allows, such as a scoped
   * CDK bootstrap. Validated as `tenantBuildManagedPolicyArns` is. The cell
   * role also trusts the control-plane API role (ADR-0028), so the API role
   * can use every policy attached here too.
   */
  readonly cellBuildManagedPolicyArns?: string[];
  /** The stack's resolved partition and account, for the managed-policy ARN check. */
  readonly identity: StackIdentity;
}

/** IAM's default role trust policy size quota, in characters (adjustable to 4,096). */
export const TRUST_POLICY_DEFAULT_QUOTA = 2048;
/** The tenant half's trust without the fleet name and external id, measured by synth. */
const TENANT_TRUST_BASE_CHARS = 1165;

/**
 * The account role pair (spec §6.4, ADR-025): `<fleet>-cell-provisioning`
 * and `<fleet>-tenant-provisioning`, installed in every account that hosts
 * cells — the control plane's own account included (P-4). Each role trusts
 * its control-plane build role and the control-plane API role (for the
 * registration probe, ADR-027/028), by ARN, and never a hook role (spec
 * R-41: a hook never acts in a cell account). The build role must pass the
 * session tags of ADR-0051 and nothing else; the API role passes none. It
 * carries the asymmetric §6.2 namespace grants, named by those tags: the
 * cell role owns its own `/application-plane/cells/<cellId>`, the tenant
 * role reads its cell's and owns its own
 * `/application-plane/tenants/<tenantId>/<applicationId>`. These
 * roles — not the build roles — are THE hardening point (P-12): the account
 * owner decides what provisioning may do in their account and can withdraw
 * it by deleting the pair.
 *
 * The trust principal is the control plane ACCOUNT, narrowed to the build
 * role by an `aws:PrincipalArn` condition, rather than the role ARN itself:
 * IAM validates a role-ARN principal at create time, which would force the
 * control plane to exist before a customer can install the pair and would
 * break the trust if the build role were ever recreated.
 */
export class CellAccountRoles extends Construct {
  readonly cellRole: iam.Role;
  readonly tenantRole: iam.Role;
  readonly fleetName: string;

  constructor(scope: Construct, id: string, props: CellAccountRolesProps) {
    super(scope, id);
    this.fleetName = validateFleetName(props.fleetName ?? DEFAULT_FLEET_NAME);
    validateTenantBuildManagedPolicyArns(props.tenantBuildManagedPolicyArns, props.identity);
    validateCellBuildManagedPolicyArns(props.cellBuildManagedPolicyArns, props.identity);
    const externalId = props.externalId === undefined ? undefined : validateExternalId(props.externalId);
    const partition = props.identity.partition;
    if (externalId !== undefined) {
      // Each half's trust holds the external id twice (one per AssumeRole
      // statement). The tenant half is the larger: measured by synth at
      // about 1,165 characters plus 3 per fleet name character, plus the id
      // twice. Warn at synth rather than fail at CloudFormation deploy.
      const tenantTrustChars = TENANT_TRUST_BASE_CHARS + 3 * this.fleetName.length + 2 * externalId.length;
      if (tenantTrustChars > TRUST_POLICY_DEFAULT_QUOTA) {
        Annotations.of(this).addWarningV2(
          'control-plane:trustPolicySize',
          `The external id is ${externalId.length} characters: the tenant provisioning role's trust holds it twice and `
          + `is about ${tenantTrustChars} characters, over IAM's default trust policy size quota of `
          + `${TRUST_POLICY_DEFAULT_QUOTA}. Use a shorter id, or raise the account's quota (up to 4,096) before deploying.`,
        );
      }
    }

    // Each half trusts two control-plane roles in three statements: the API
    // role (the PutAccount handshake probe, ADR-027/028) may assume it with
    // no session tags; the matching build role (the scripts) may assume it
    // only with every one of its session tag keys and no other, and tag the
    // session only with those keys, at least one of them transitive
    // (ADR-0051; the buildspec makes all of them transitive), so a build
    // session always names its cell, and its tenant and application on a
    // tenant build. The API role stays untagged because the TagSession
    // statement names the build role only. The external id is a condition of
    // the AssumeRole statements only: STS does not evaluate it on
    // TagSession, where it would refuse every tagged request.
    const withExternalId = (conditions: Record<string, Record<string, string | string[]>>) =>
      externalId === undefined ? conditions : { ...conditions, StringEquals: { 'sts:ExternalId': externalId } };
    const apiTrust = new iam.PrincipalWithConditions(
      new iam.AccountPrincipal(props.controlPlaneAccountId),
      withExternalId({ ArnEquals: { 'aws:PrincipalArn': apiRoleArn(partition, props.controlPlaneAccountId, this.fleetName) } }),
    );
    const trustBuildRole = (role: iam.Role, kind: ProvisioningRoleKind) => {
      const buildRole = { 'aws:PrincipalArn': buildRoleArn(partition, props.controlPlaneAccountId, this.fleetName, kind) };
      role.assumeRolePolicy!.addStatements(
        new iam.PolicyStatement({
          actions: ['sts:AssumeRole'],
          principals: [new iam.AccountPrincipal(props.controlPlaneAccountId)],
          conditions: withExternalId({ ArnEquals: buildRole, ...sessionTagRequestConditions(kind) }),
        }),
        new iam.PolicyStatement({
          actions: ['sts:TagSession'],
          principals: [new iam.AccountPrincipal(props.controlPlaneAccountId)],
          conditions: { ArnEquals: buildRole, ...sessionTagConditions(kind) },
        }),
      );
    };

    this.cellRole = new iam.Role(this, 'CellProvisioningRole', {
      roleName: provisioningRoleName(this.fleetName, 'cell'),
      assumedBy: apiTrust,
      description: `Assumed by the ${this.fleetName} control plane's cell build to run cell scripts in this account (spec §6.4)`,
    });
    trustBuildRole(this.cellRole, 'cell');
    this.cellRole.addToPolicy(readSharedResourcesStatement(this));
    this.cellRole.addToPolicy(manageCellNamespaceStatement(this));
    acknowledgeSsmNamespaceGrant(this.cellRole, '/application-plane/shared/*');
    acknowledgeSsmNamespaceGrant(this.cellRole, '/application-plane/applications/*');
    acknowledgeTaggedSsmGrant(this.cellRole, OWN_CELL_PATH);
    // ADR-0047: the account owner widens their own cell role by exactly what
    // they attach, as for the tenant role. Attached by reference, never read (P-3).
    (props.cellBuildManagedPolicyArns ?? []).forEach((arn, index) => {
      this.cellRole.addManagedPolicy(
        iam.ManagedPolicy.fromManagedPolicyArn(this, `CellBuildManagedPolicy${index}`, arn),
      );
    });

    this.tenantRole = new iam.Role(this, 'TenantProvisioningRole', {
      roleName: provisioningRoleName(this.fleetName, 'tenant'),
      assumedBy: apiTrust,
      description: `Assumed by the ${this.fleetName} control plane's tenant build to run tenant scripts in this account (spec §6.4)`,
    });
    trustBuildRole(this.tenantRole, 'tenant');
    this.tenantRole.addToPolicy(readSharedResourcesStatement(this));
    this.tenantRole.addToPolicy(readCellNamespaceStatement(this));
    this.tenantRole.addToPolicy(manageTenantNamespaceStatement(this));
    acknowledgeSsmNamespaceGrant(this.tenantRole, '/application-plane/shared/*');
    acknowledgeSsmNamespaceGrant(this.tenantRole, '/application-plane/applications/*');
    acknowledgeTaggedSsmGrant(this.tenantRole, OWN_CELL_PATH);
    acknowledgeTaggedSsmGrant(this.tenantRole, OWN_DEPLOYMENT_PATH);
    // ADR-022/025: the account owner widens their own tenant role by
    // exactly what they attach. Attached by reference, never read (P-3).
    (props.tenantBuildManagedPolicyArns ?? []).forEach((arn, index) => {
      this.tenantRole.addManagedPolicy(
        iam.ManagedPolicy.fromManagedPolicyArn(this, `TenantBuildManagedPolicy${index}`, arn),
      );
    });

    for (const role of [this.cellRole, this.tenantRole]) {
      suppressTemplateScanners(role, {
        cfnNag: [
          { id: 'W28', reason: 'Physical role names are the cross-account contract (spec §6.4): the control plane assumes the pair by name in any registered account, and the account owner installs it by the same name.' },
        ],
      });
      suppressTemplateScanners(role.node.findChild('DefaultPolicy'), {
        cfnNag: [{ id: 'W76', reason: 'Least-privilege policy with granular per-namespace statements (ADR-010); the statement-point count reflects explicit scoping, not over-breadth.' }],
      });
    }
  }
}

export interface CellAccountStackProps extends StackProps, Omit<CellAccountRolesProps, 'identity'> {
  /**
   * DEMO ONLY: application ids for which this stack publishes
   * `/application-plane/applications/<id>/shared/base-domain` in this
   * account so the sample cell script has a shared resource to read
   * (ADR-034). A real deployment's application plane publishes its own
   * (ADR-010). Default: none, so a customer's account receives the two
   * roles and nothing else unless they ask for the demo parameters.
   */
  readonly demoApplicationIds?: string[];
}

/**
 * The deployable account role pair (spec R-25): one stack per account that
 * hosts cells, deployed by that account's owner — the vendor for fleet
 * accounts, the customer for a tenant-owned one. The control plane stack
 * installs the same pair in its own account, so this stack is for every
 * OTHER account. Inputs: the control plane account, the fleet name, an
 * external id (required for a tenant-owned account, ADR-029), and optional
 * managed policies for the tenant role (ADR-022) and the cell role (ADR-0047).
 */
export class CellAccountStack extends Stack {
  readonly roles: CellAccountRoles;

  constructor(scope: Construct, id: string, props: CellAccountStackProps) {
    super(scope, id, props);
    if (!/^\d{12}$/.test(props.controlPlaneAccountId)) {
      throw new Error(
        `Invalid controlPlaneAccountId ${JSON.stringify(props.controlPlaneAccountId)}: expected a 12-digit AWS account id`,
      );
    }
    this.roles = new CellAccountRoles(this, 'Roles', {
      ...props,
      identity: stackIdentity(this),
    });

    for (const applicationId of props.demoApplicationIds ?? []) {
      // DEMO ONLY: stands in for application-plane shared infrastructure in
      // this account, one namespace per application (ADR-010, ADR-034).
      // Each account's application plane is its own.
      new ssm.StringParameter(this, `DemoSharedBaseDomain-${applicationId}`, {
        parameterName: `/application-plane/applications/${applicationId}/shared/base-domain`,
        stringValue: `${applicationId}.cells.example.com`,
      });
    }

    new CfnOutput(this, 'CellProvisioningRoleArn', { value: this.roles.cellRole.roleArn });
    new CfnOutput(this, 'TenantProvisioningRoleArn', { value: this.roles.tenantRole.roleArn });
  }
}
