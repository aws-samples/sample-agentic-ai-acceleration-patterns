// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App, Aspects, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { CellAccountStack } from './cell-account/cell-account.cdk';
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
// Optional inputs: tenantBuildManagedPolicyArns (ADR-022), fleetName
// (ADR-025, default `control-plane`) and demoApplicationIds (the sample
// scripts' shared parameter, ADR-034).
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
  // the tenant provisioning role (attached in THIS account, ADR-022/025).
  // The stack name carries the fleet name so two fleets' pairs can be
  // installed in one account without a CloudFormation stack collision (T31).
  new CellAccountStack(app, `${validateFleetName(fleetName ?? DEFAULT_FLEET_NAME)}-cell-account`, {
    controlPlaneAccountId: String(cellAccount.controlPlaneAccountId ?? ''),
    fleetName,
    externalId: cellAccount.externalId,
    tenantBuildManagedPolicyArns: cellAccount.tenantBuildManagedPolicyArns,
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
  // Optional, DEMO ONLY: the applications the sample scripts will be
  // registered under, so their shared parameter exists in the home account.
  const demoApplicationIds = parseJsonContext<string[]>('demoApplicationIds');

  new TenantStack(app, 'control-plane-dev', {
    vendorIdpIssuerUrl: String(vendorIdpIssuerUrl),
    vendorIdpAudience: String(vendorIdpAudience),
    fleetName,
    tenantBuildManagedPolicyArns,
    demoApplicationIds,
    env,
  });
}

app.synth();

/** The `cellAccount` context shape (spec §3.3, "Account role pair"). */
interface CellAccountContext {
  readonly controlPlaneAccountId?: string;
  readonly externalId?: string;
  readonly tenantBuildManagedPolicyArns?: string[];
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

/**
 * Reads an OPTIONAL context value given as a structured value (cdk.json) or
 * a JSON string (`--context key='[...]'`). Absent or empty means undefined;
 * structural validation happens in the stack.
 */
function parseJsonContext<T>(key: string): T | undefined {
  const value = app.node.tryGetContext(key);
  if (value === undefined || value === '') {
    return undefined;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch (error) {
      throw new Error(`The ${key} context value is not valid JSON: ${(error as Error).message}`);
    }
  }
  return value as T;
}
