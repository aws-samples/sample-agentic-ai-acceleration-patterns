// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App, Aspects, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { CellAccountStack } from './cell-account/cell-account.cdk';
import { readJsonContext } from './shared/context';
import { DEFAULT_FLEET_NAME, validateFleetName } from './shared/fleet';
import { TenantStack } from './tenant/tenant.cdk';

const app = new App();

// Security linting (cdk-nag v3): evaluate every construct against the AWS
// Solutions rule pack at synth time via CDK's policy validation framework.
// Findings fail synthesis; intentional deviations are acknowledged per
// construct with a documented reason. writeSuppressionsToCloudFormation
// copies each acknowledgment into the synthesized templates as
// cdk_nag.rules_to_suppress Metadata - the audit trail travels with the
// templates (and the committed integ snapshot) alongside the cfn_nag and
// checkov annotations.
Validations.of(app).addPlugins(
  new AwsSolutionsChecks(app, { verbose: true, writeSuppressionsToCloudFormation: true }),
);

// Stack inputs (spec §3.3), supplied via CDK context (cdk.json or
// --context). The vendor IdP values are required — synthesis fails fast
// rather than deploying a stack whose every request 500s against a
// placeholder issuer (S3). Customer identity is an application plane
// decision (ADR-004). Applications and accounts are NOT stack inputs: they
// are registered through the API at run time (ADR-024, ADR-032).
// Optional inputs: tenantBuildManagedPolicyArns (ADR-022),
// cellBuildManagedPolicyArns (ADR-0047), concurrentBuildLimit (ADR-0046,
// default 5), fleetName
// (ADR-025, default `control-plane`), demoApplicationIds (the sample
// scripts' shared parameter, ADR-034), and the role lists allowedRoles
// (default ["operator"]) and readerRoles (default none) (spec R-36, ADR-042),
// vendorIdpClientIds (default none), the client ids accepted on a token
// without `aud`, and vendorIdpRequiredScope (default none), the scope such a
// token must also carry (spec R-38, ADR-043).
//
// A second mode (ADR-025): `--context cellAccount='{...}'` synthesizes ONLY
// the account role pair stack, for deployment into another account by its
// owner (the vendor's second fleet account, or a customer's). That mode needs
// none of the control plane inputs.
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};
const fleetName = app.node.tryGetContext('fleetName') as string | undefined;
const cellAccount = parseJsonContext<CellAccountContext>('cellAccount');

if (cellAccount !== undefined) {
  // The account role pair (spec R-25, §6.4): deployed by the owner of the
  // account that will host cells, with the control plane's account id and
  // fleet name, an optional external id, and optional managed policies for
  // the tenant and cell provisioning roles (attached in THIS account,
  // ADR-022/025, ADR-0047).
  // The stack name carries the fleet name so two fleets' pairs can be
  // installed in one account without a CloudFormation stack collision (T31).
  new CellAccountStack(app, `${validateFleetName(fleetName ?? DEFAULT_FLEET_NAME)}-cell-account`, {
    controlPlaneAccountId: String(cellAccount.controlPlaneAccountId ?? ''),
    fleetName,
    externalId: cellAccount.externalId,
    tenantBuildManagedPolicyArns: cellAccount.tenantBuildManagedPolicyArns,
    cellBuildManagedPolicyArns: cellAccount.cellBuildManagedPolicyArns,
    demoApplicationIds: cellAccount.demoApplicationIds,
    env,
  });
} else {
  const vendorIdpIssuerUrl = requireContext('vendorIdpIssuerUrl');
  const vendorIdpAudience = requireContext('vendorIdpAudience');
  // Optional (ADR-022): customer-managed policy ARNs attached to the tenant
  // provisioning role in the control plane's own account, e.g. a
  // least-privilege policy an application-plane sample publishes for its
  // API. Validated in the stack (fails synth on an ARN outside this
  // partition/account). Default: none.
  const tenantBuildManagedPolicyArns = parseJsonContext<string[]>('tenantBuildManagedPolicyArns');
  // Optional (ADR-0047): the same, for the home account's cell provisioning role.
  const cellBuildManagedPolicyArns = parseJsonContext<string[]>('cellBuildManagedPolicyArns');
  // Optional (ADR-0046): concurrent builds per CodeBuild project, 1 to 100.
  // A JSON number from cdk.json or a string from --context; the stack
  // validates the range.
  const concurrentBuildLimit = parseJsonContext<number>('concurrentBuildLimit');
  // Optional, DEMO ONLY: the applications the sample scripts will be
  // registered under, so their shared parameter exists in the home account.
  const demoApplicationIds = parseJsonContext<string[]>('demoApplicationIds');
  // Optional (R-36): role claim values for the operator and reader grants.
  const allowedRoles = parseJsonContext<string[]>('allowedRoles');
  const readerRoles = parseJsonContext<string[]>('readerRoles');
  // Optional (R-38): client ids accepted on a token without `aud`.
  const vendorIdpClientIds = parseJsonContext<string[]>('vendorIdpClientIds');
  const vendorIdpRequiredScope = app.node.tryGetContext('vendorIdpRequiredScope') as string | undefined;

  new TenantStack(app, 'control-plane-dev', {
    vendorIdpIssuerUrl: String(vendorIdpIssuerUrl),
    vendorIdpAudience: String(vendorIdpAudience),
    vendorIdpClientIds,
    vendorIdpRequiredScope,
    fleetName,
    tenantBuildManagedPolicyArns,
    cellBuildManagedPolicyArns,
    concurrentBuildLimit,
    demoApplicationIds,
    allowedRoles,
    readerRoles,
    env,
  });
}

app.synth();

/** The `cellAccount` context shape (spec §3.3, "Account role pair"). */
interface CellAccountContext {
  readonly controlPlaneAccountId?: string;
  readonly externalId?: string;
  readonly tenantBuildManagedPolicyArns?: string[];
  readonly cellBuildManagedPolicyArns?: string[];
  readonly demoApplicationIds?: string[];
}

/** Fails synthesis with the complete required-context recipe when a stack input is missing. */
function requireContext(key: string): unknown {
  const value = app.node.tryGetContext(key);
  if (value === undefined || value === '') {
    throw new Error(
      [
        `Missing required CDK context '${key}'. This app needs both vendor IdP inputs (spec §3.3)`
        + ' - or `--context cellAccount=\'{"controlPlaneAccountId":"..."}\'` to synthesize only the account role pair stack:',
        '',
        '  npx cdk deploy \\',
        '    --context vendorIdpIssuerUrl=https://YOUR_ISSUER \\',
        '    --context vendorIdpAudience=YOUR_AUDIENCE',
        '',
        'Applications are registered after deployment with PutApplication; see the README "Deploy" section.',
      ].join('\n'),
    );
  }
  return value;
}

/** Reads an OPTIONAL JSON context value (see `readJsonContext`). */
function parseJsonContext<T>(key: string): T | undefined {
  return readJsonContext<T>(app.node, key);
}
