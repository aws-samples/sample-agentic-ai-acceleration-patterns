// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import {
  apiRoleArn,
  buildRoleArn,
  DEFAULT_FLEET_NAME,
  provisioningRoleName,
  validateExternalId,
  validateFleetName,
} from '../shared/fleet';
import { suppressTemplateScanners } from '../shared/nag';
import {
  acknowledgeSsmNamespaceGrant,
  manageCellNamespaceStatement,
  manageTenantNamespaceStatement,
  readCellNamespaceStatement,
  readSharedResourcesStatement,
} from '../shared/ssm-namespaces';
import { stackIdentity, StackIdentity, validateTenantBuildManagedPolicyArns } from '../tenant/validation';

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
  /** The stack's resolved partition and account, for the managed-policy ARN check. */
  readonly identity: StackIdentity;
}

/**
 * The account role pair (spec §6.4, ADR-025): `<fleet>-cell-provisioning`
 * and `<fleet>-tenant-provisioning`, installed in every account that hosts
 * cells — the control plane's own account included (P-4). Each role trusts
 * its control-plane build role and the control-plane API role (for the
 * registration probe, ADR-027/028), by ARN, and carries the asymmetric
 * §6.2 namespace grants: the cell role owns `/application-plane/cells/*`,
 * the tenant role reads it and owns `/application-plane/tenants/*`. These
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
    const externalId = props.externalId === undefined ? undefined : validateExternalId(props.externalId);
    const partition = props.identity.partition;

    // Each half trusts two control-plane roles: the matching build role (the
    // scripts) and the API role (the PutAccount handshake probe, ADR-027/028).
    const trust = (kind: 'cell' | 'tenant') => {
      const conditions: Record<string, Record<string, string | string[]>> = {
        ArnEquals: {
          'aws:PrincipalArn': [
            buildRoleArn(partition, props.controlPlaneAccountId, this.fleetName, kind),
            apiRoleArn(partition, props.controlPlaneAccountId, this.fleetName),
          ],
        },
      };
      if (externalId !== undefined) {
        conditions.StringEquals = { 'sts:ExternalId': externalId };
      }
      return new iam.PrincipalWithConditions(
        new iam.AccountPrincipal(props.controlPlaneAccountId),
        conditions,
      );
    };

    this.cellRole = new iam.Role(this, 'CellProvisioningRole', {
      roleName: provisioningRoleName(this.fleetName, 'cell'),
      assumedBy: trust('cell'),
      description: `Assumed by the ${this.fleetName} control plane's cell build to run cell scripts in this account (spec §6.4)`,
    });
    this.cellRole.addToPolicy(readSharedResourcesStatement(this));
    this.cellRole.addToPolicy(manageCellNamespaceStatement(this));
    acknowledgeSsmNamespaceGrant(this.cellRole, '/application-plane/shared/*');
    acknowledgeSsmNamespaceGrant(this.cellRole, '/application-plane/applications/*');
    acknowledgeSsmNamespaceGrant(this.cellRole, '/application-plane/cells/*');

    this.tenantRole = new iam.Role(this, 'TenantProvisioningRole', {
      roleName: provisioningRoleName(this.fleetName, 'tenant'),
      assumedBy: trust('tenant'),
      description: `Assumed by the ${this.fleetName} control plane's tenant build to run tenant scripts in this account (spec §6.4)`,
    });
    this.tenantRole.addToPolicy(readSharedResourcesStatement(this));
    this.tenantRole.addToPolicy(readCellNamespaceStatement(this));
    this.tenantRole.addToPolicy(manageTenantNamespaceStatement(this));
    acknowledgeSsmNamespaceGrant(this.tenantRole, '/application-plane/shared/*');
    acknowledgeSsmNamespaceGrant(this.tenantRole, '/application-plane/applications/*');
    acknowledgeSsmNamespaceGrant(this.tenantRole, '/application-plane/cells/*');
    acknowledgeSsmNamespaceGrant(this.tenantRole, '/application-plane/tenants/*');
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
 * managed policies for the tenant role.
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
