// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as path from 'path';
import { ExpectedResult, IntegTest, Match } from '@aws-cdk/integ-tests-alpha';
import { App, Aspects, Aws, CfnResource, Duration, IAspect, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { ApplicationLogLevel } from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { WriteNagSuppressionsToCloudFormationAspect } from 'cdk-nag';
import { IConstruct } from 'constructs';
import { CellAccountStack } from '../src/cell-account/cell-account.cdk';
import { suppressTemplateScanners } from '../src/shared/nag';
import { TenantStack } from '../src/tenant/tenant.cdk';

/**
 * End-to-end integration test for the cell-based control plane across TWO
 * accounts and TWO applications (spec §10).
 *
 * Accounts: A is the account the test runs in (the control plane's own,
 * registered as vendor-owned and shared, with room for two cells); B is a
 * second account, named by `CP_INTEG_ACCOUNT_B`, registered as tenant-owned
 * with room for one cell, an external id, and dedicated to application Y. B
 * must be CDK-bootstrapped trusting A (`cdk bootstrap aws://<B>/<region>
 * --trust <A>`), because this app deploys the account role pair into B with
 * A's credentials.
 *
 * Setup (in A): a throwaway Cognito user pool acts as the vendor IdP (its ID
 * tokens carry iss + aud, which the authorizer validates via OIDC discovery,
 * plus the `role: "operator"` claim ADR-018 requires, added by a pre token
 * generation trigger); the sample cell + tenant scripts are hosted in an S3
 * bucket used as the applications' CodeBuild ProjectSource; and a probe
 * Lambda that assumes a read-only role in B to count SSM parameters there
 * (the assertion provider itself runs in A only). Applications X and Y share
 * that source and differ in id; maxTenants = 1: every cell is a silo, so
 * cells — not deployments — are what the accounts count.
 *
 * Flow (every API operation is exercised; the numbers are spec §10's steps,
 * with the operator minted in step 1):
 *   1. unauthenticated request → 401; mint an operator: adminCreateUser →
 *      adminSetUserPassword → adminInitiateAuth → ID token
 *   2. PutApplication with a missing script → 400, bad id → 400; X and Y →
 *      200; ListApplications; PutAccount naming an unknown application → 404
 *   3. PutAccount handshake refusals (no pair, pair not enforcing the id, no
 *      external id, wrong external id) → 400; PutAccount A (VENDOR, 2,
 *      shared) and B (TENANT, 1, external id, Y only) → 200; ListAccounts
 *   4. CreateTenant T1, T2, T3 → 200, no cell; DeleteTenant T3 → 200;
 *      CreateDeployment for T3 or an unknown application → 404
 *   5. CreateDeployment T1/X (clientToken) → cell 1 in A → poll ACTIVE;
 *      GetDeployment resolves the stamp; A 1/2, X 1, T1 1; parameters in A
 *   6. CreateDeployment T1/Y → cell 2 in A; A 2/2, Y 1, T1 2; filters;
 *      each cell read ITS application's shared namespace; T1/X again → 409;
 *      DeleteTenant T1 → 409 (occupied)
 *   7. replay T1/X with the same token → the same deployment (ADR-017);
 *      the token with another application → 409
 *   8. CreateDeployment T2/X untargeted → 409 InsufficientCapacity (A full,
 *      B tenant-owned)
 *   9. T2/X at B → 400 (B admits Y only, ADR-033)
 *  10. CreateDeployment T2/Y at B → cell 3 in B; in-flight delete → 409;
 *      parameters in B and not in A; B 1/1, Y 2
 *  11. T4/Y at B → 409 (full); DeleteAccount B, DeleteApplication Y → 409;
 *      owner change → 409
 *  12. reads: ListCells with filters, two filters → 400; ListDeployments
 *      with filters; UpdateTenant; PutApplication Y replaced, cells 2 and 3
 *      keep their stamp (P-4)
 *  13. UpdateDeployment T1/X (in A) and UpdateCell cell 3 (in B) → ACTIVE
 *  14. DeleteCell occupied → 409; DeleteDeployment T1/X → 404; cell 1 stays
 *      0/1, A 2/2, X 1, T1 1; CreateDeployment T2/X reuses cell 1
 *  15. delete every deployment, cell, tenant, account and application; every
 *      counter back at 0; namespaces empty in both accounts
 *
 * Run with the single-Region, two-account command documented in
 * integration-test.md (deploys real infrastructure in both accounts).
 */

const accountA = requireEnv('CDK_DEFAULT_ACCOUNT', 'the account the test runs in (the integ task resolves it with sts get-caller-identity)');
const accountB = requireEnv('CP_INTEG_ACCOUNT_B', 'the second, tenant-owned test account (12 digits), CDK-bootstrapped to trust this one');
const region = process.env.AWS_REGION ?? requireEnv('CDK_DEFAULT_REGION', 'the single Region to test in (the integ task sets AWS_REGION)');
if (!/^\d{12}$/.test(accountB) || accountB === accountA) {
  throw new Error('CP_INTEG_ACCOUNT_B must be a 12-digit AWS account id different from the account the test runs in');
}
/** No account has the pair installed under this id: the handshake must refuse it. */
const unregisteredAccount = '000000000000';
/** The external id account B's role pair requires (spec §6.4) — a handshake value, not a secret. */
const accountBExternalId = 'control-plane-integ-handshake';
/** The two applications (spec §10): same scripts, different ids. B admits Y only. */
const APP_X = 'integ-x';
const APP_Y = 'integ-y';

const app = new App();

// --- Setup stack (account A): vendor IdP + script source + probe ----------
// The account A stacks stay environment-agnostic (they deploy to the ambient
// account, as the assertion stack does); only the account B stack names its
// environment.
const setup = new Stack(app, 'control-plane-integ-setup');

const vendorIdp = new cognito.UserPool(setup, 'VendorIdp', {
  selfSignUpEnabled: false,
  removalPolicy: RemovalPolicy.DESTROY,
});
// ADR-018 deployment contract: the vendor IdP must mint `role: "operator"`
// on operator tokens - the authorizer fails closed on a missing role. A
// plain Cognito ID token carries no such claim, so this pre token
// generation trigger (V1_0 event, ID token only) adds it, exactly as a real
// vendor IdP would be configured to.
const mintOperatorRole = new lambda.Function(setup, 'MintOperatorRole', {
  runtime: lambda.Runtime.NODEJS_24_X,
  handler: 'index.handler',
  code: lambda.Code.fromInline(`
    exports.handler = async (event) => {
      event.response = {
        claimsOverrideDetails: {
          claimsToAddOrOverride: { role: 'operator' },
        },
      };
      return event;
    };
  `),
});
vendorIdp.addTrigger(cognito.UserPoolOperation.PRE_TOKEN_GENERATION, mintOperatorRole);
const idpClient = vendorIdp.addClient('IntegOperatorClient', {
  authFlows: { adminUserPassword: true },
  generateSecret: false,
});

const scriptsBucket = new s3.Bucket(setup, 'LifecycleScripts', {
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  encryption: s3.BucketEncryption.S3_MANAGED,
  enforceSSL: true,
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});
suppressTemplateScanners(scriptsBucket, {
  cfnNag: [
    { id: 'W35', reason: 'Ephemeral integ-test script source, auto-deleted on teardown; access logging adds no value for a short-lived test artifact.' },
  ],
  checkov: [
    { id: 'CKV_AWS_18', comment: 'Ephemeral integ-test script source, auto-deleted on teardown; access logging adds no value for a short-lived test artifact.' },
    { id: 'CKV_AWS_21', comment: 'Ephemeral integ-test script source, auto-deleted on teardown; versioning adds no value for a short-lived test artifact.' },
  ],
});
new s3deploy.BucketDeployment(setup, 'DeployCellScripts', {
  destinationBucket: scriptsBucket,
  destinationKeyPrefix: 'scripts/sample-cell',
  sources: [s3deploy.Source.asset(path.join(__dirname, '../scripts/sample-cell'))],
});
new s3deploy.BucketDeployment(setup, 'DeployTenantScripts', {
  destinationBucket: scriptsBucket,
  destinationKeyPrefix: 'scripts/sample-tenant',
  sources: [s3deploy.Source.asset(path.join(__dirname, '../scripts/sample-tenant'))],
});

// The assertion provider runs in account A. To check what the scripts did
// in account B, this probe assumes a read-only role there (installed by the
// account B stack below, trusted by this function's role) and counts SSM
// parameters: by path (recursive) and/or by exact names. Returns the count.
const probeRoleName = 'control-plane-integ-probe';
const probeRoleArn = `arn:${setup.partition}:iam::${accountB}:role/${probeRoleName}`;
const ssmProbe = new lambda.Function(setup, 'SsmProbe', {
  runtime: lambda.Runtime.NODEJS_24_X,
  handler: 'index.handler',
  timeout: Duration.seconds(30),
  code: lambda.Code.fromInline(`
    const { STSClient, AssumeRoleCommand } = require('@aws-sdk/client-sts');
    const { SSMClient, GetParametersByPathCommand, GetParametersCommand } = require('@aws-sdk/client-ssm');
    exports.handler = async (event) => {
      const sts = new STSClient({});
      const assumed = await sts.send(new AssumeRoleCommand({
        RoleArn: event.roleArn, RoleSessionName: 'control-plane-integ-probe',
      }));
      const c = assumed.Credentials;
      const ssm = new SSMClient({
        region: event.region,
        credentials: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken },
      });
      let count = 0;
      if (event.path) {
        let token;
        do {
          const page = await ssm.send(new GetParametersByPathCommand({ Path: event.path, Recursive: true, NextToken: token }));
          count += (page.Parameters || []).length;
          token = page.NextToken;
        } while (token);
      }
      if (event.names && event.names.length > 0) {
        const got = await ssm.send(new GetParametersCommand({ Names: event.names }));
        count += (got.Parameters || []).length;
      }
      return count;
    };
  `),
});
ssmProbe.addToRolePolicy(new iam.PolicyStatement({
  actions: ['sts:AssumeRole'],
  resources: [probeRoleArn],
}));

// --- Account B stack: the role pair a customer installs + the test probe role
// Deployed into B with A's credentials (B is bootstrapped to trust A). The
// pair trusts A's build roles by ARN with the external id; nothing in A has
// to exist first (the trust is account + aws:PrincipalArn, ADR-025).
const accountBStack = new CellAccountStack(app, 'control-plane-integ-account-b', {
  controlPlaneAccountId: accountA,
  externalId: accountBExternalId,
  // The sample cell script reads its application's demo shared parameter
  // (ADR-034); B hosts cells of Y only.
  demoApplicationIds: [APP_Y],
  env: { account: accountB, region },
});
const probeRole = new iam.Role(accountBStack, 'IntegProbeRole', {
  roleName: probeRoleName,
  description: 'control-plane integ test only: lets the probe Lambda in the control plane account count SSM parameters here',
  assumedBy: new iam.PrincipalWithConditions(new iam.AccountPrincipal(accountA), {
    ArnLike: { 'aws:PrincipalArn': `arn:${accountBStack.partition}:iam::${accountA}:role/control-plane-integ-setup-SsmProbe*` },
  }),
});
probeRole.addToPolicy(new iam.PolicyStatement({
  actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
  resources: [accountBStack.formatArn({ service: 'ssm', resource: 'parameter', resourceName: 'application-plane/*' })],
}));

// --- Stack under test (account A) ------------------------------------------
// Two applications share one definition — the sample scripts in the test
// bucket — and differ only in id (spec §10). maxTenants = 1: every cell is a
// silo, so the account cell limits are what fill up. The definition is a
// run-time registration (PutApplication, ADR-032), not a stack input.
const definition = {
  source: { type: 'S3', location: `${scriptsBucket.bucketName}/scripts/` },
  cellScripts: {
    create: 'sample-cell/create.sh',
    update: 'sample-cell/update.sh',
    delete: 'sample-cell/delete.sh',
  },
  tenantScripts: {
    create: 'sample-tenant/create.sh',
    update: 'sample-tenant/update.sh',
    delete: 'sample-tenant/delete.sh',
  },
  maxTenants: 1,
};

const stack = new TenantStack(app, 'control-plane-integ', {
  vendorIdpIssuerUrl: vendorIdp.userPoolProviderUrl,
  vendorIdpAudience: idpClient.userPoolClientId,
  // The sample cell script reads each application's shared parameter in the
  // account it runs in (ADR-034); A hosts cells of both applications.
  demoApplicationIds: [APP_X, APP_Y],
});
// Both shared CodeBuild projects pull the stamped source from the test
// bucket (the source fetch runs under the build role, before the buildspec
// assumes the account's provisioning role).
scriptsBucket.grantRead(stack.provisioning.cellProject);
scriptsBucket.grantRead(stack.provisioning.tenantProject);

// --- Assertions --------------------------------------------------------------
const integ = new IntegTest(app, 'ControlPlaneInteg', {
  testCases: [setup, accountBStack, stack],
  // INFO makes the assertion provider log each request/response to
  // CloudWatch - invaluable when an ApiCall attribute fails to resolve.
  providerLogLevel: ApplicationLogLevel.INFO,
  cdkCommandOptions: { destroy: { args: { force: true } } },
});

// Template-scanner (cfn_nag/checkov) annotations for CDK-owned constructs
// this test does not author: the setup stack's custom-resource providers
// (S3 auto-delete, BucketDeployment), the probe, the account B test role,
// and the integ-tests-alpha assertion harness. The stack under test carries
// targeted annotations in source instead, so it is deliberately excluded.
const HARNESS_REASON =
  'CDK-managed custom resource provider / integ-test assertion harness - test scaffolding, not part of the sample\'s deployable surface.';
class HarnessScannerSuppressions implements IAspect {
  public visit(node: IConstruct): void {
    if (!CfnResource.isCfnResource(node) || Stack.of(node) === stack) {
      return;
    }
    switch (node.cfnResourceType) {
      case 'AWS::Lambda::Function':
        suppressTemplateScanners(node, {
          cfnNag: ['W58', 'W89', 'W92'].map((id) => ({ id, reason: HARNESS_REASON })),
          checkov: ['CKV_AWS_115', 'CKV_AWS_116', 'CKV_AWS_117', 'CKV_AWS_173'].map(
            (id) => ({ id, comment: HARNESS_REASON }),
          ),
        });
        break;
      case 'AWS::Logs::LogGroup':
        suppressTemplateScanners(node, {
          cfnNag: [{ id: 'W84', reason: HARNESS_REASON }],
          checkov: [{ id: 'CKV_AWS_158', comment: HARNESS_REASON }],
        });
        break;
      case 'AWS::IAM::Policy':
      case 'AWS::IAM::Role':
        suppressTemplateScanners(node, {
          cfnNag: ['W11', 'W12', 'W28', 'W76'].map((id) => ({ id, reason: HARNESS_REASON })),
          checkov: ['CKV_AWS_107', 'CKV_AWS_108', 'CKV_AWS_109', 'CKV_AWS_110', 'CKV_AWS_111'].map(
            (id) => ({ id, comment: HARNESS_REASON }),
          ),
        });
        break;
    }
  }
}
Aspects.of(app).add(new HarnessScannerSuppressions());

// The integ app does not run the AwsSolutionsChecks plugin (the harness
// stacks are not held to the sample's rule pack), but the stack under test
// records its cdk-nag acknowledgments either way - this aspect copies them
// into the synthesized templates as cdk_nag.rules_to_suppress Metadata so
// the audit trail is visible in the committed snapshot (mirrors
// writeSuppressionsToCloudFormation in src/main.ts).
Aspects.of(app).add(new WriteNagSuppressionsToCloudFormationAspect());

const adminEmail = 'success+integ-operator@simulator.amazonses.com';
const apiUrl = stack.apiUrl;

// Polling budgets: onboarding into a NEW cell runs two CodeBuild builds in
// one execution (cell create, then tenant create). Single-build operations
// keep the 15-minute budget.
const newCellPoll = {
  totalTimeout: Duration.minutes(30),
  interval: Duration.seconds(30),
};
const singleBuildPoll = {
  totalTimeout: Duration.minutes(15),
  interval: Duration.seconds(30),
};

// A syntactically valid ULID that no cell will ever have — the unknown-cell
// listing must yield an empty page, not a 404 (§5).
const unknownCellId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

// Assertion-provider grants, scoped to what the checks read: the
// application-plane namespaces in this account (the provider runs in A).
const ssmReadPolicy = {
  Effect: 'Allow',
  Action: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
  Resource: [`arn:${Aws.PARTITION}:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter/application-plane/*`],
};

/** Counts SSM parameters in account B through the probe (path and/or names). */
function probeB(id: string, query: { path?: string; names?: string[] }) {
  return integ.assertions.invokeFunction({
    functionName: ssmProbe.functionName,
    payload: JSON.stringify({ roleArn: probeRoleArn, region, ...query }),
  });
}

// 1. No vendor JWT → API Gateway rejects before any Lambda runs.
integ.assertions
  .httpApiCall(`${apiUrl}tenants`, { method: 'GET' })
  .expect(ExpectedResult.objectLike({ status: 401 }));

// 1 (continued). Mint an operator identity in the vendor IdP.
const cognitoPolicy = {
  Effect: 'Allow',
  Action: [
    'cognito-idp:AdminCreateUser',
    'cognito-idp:AdminSetUserPassword',
    'cognito-idp:AdminInitiateAuth',
  ],
  Resource: [vendorIdp.userPoolArn],
};

const createUser = integ.assertions.awsApiCall('cognito-identity-provider', 'adminCreateUser', {
  UserPoolId: vendorIdp.userPoolId,
  Username: adminEmail,
  MessageAction: 'SUPPRESS',
});
createUser.provider.addToRolePolicy(cognitoPolicy);

// Generate the operator's password at run time — never a committed literal
// (the synthesized snapshot carries only a Fn::GetAtt reference). The
// throwaway credential lives exactly as long as the assertion stack.
const randomPassword = integ.assertions.awsApiCall('secrets-manager', 'getRandomPassword', {
  PasswordLength: 32,
  RequireEachIncludedType: true,
  // The assertion provider splices this value into JSON-encoded call
  // parameters at synth time (Fn::Join around the Fn::GetAtt) - a quote or
  // backslash in the password would corrupt that encoding, so keep them
  // (and shell-sensitive quotes) out of the generated password.
  ExcludeCharacters: '"\'\\`',
});
// GetRandomPassword is a service-level action with no resource ARN; `*` is
// the only valid resource for it.
randomPassword.provider.addToRolePolicy({
  Effect: 'Allow',
  Action: ['secretsmanager:GetRandomPassword'],
  Resource: ['*'],
});
const password = randomPassword.getAttString('RandomPassword');

const setPassword = integ.assertions.awsApiCall('cognito-identity-provider', 'adminSetUserPassword', {
  UserPoolId: vendorIdp.userPoolId,
  Username: adminEmail,
  Password: password,
  Permanent: true,
});
setPassword.provider.addToRolePolicy(cognitoPolicy);

const authenticate = integ.assertions.awsApiCall(
  'cognito-identity-provider',
  'adminInitiateAuth',
  {
    UserPoolId: vendorIdp.userPoolId,
    ClientId: idpClient.userPoolClientId,
    AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: adminEmail, PASSWORD: password },
  },
  // Only the ID token - the full AuthenticationResult (three JWTs) exceeds
  // the 4KB custom resource data limit once flattened.
  ['AuthenticationResult.IdToken'],
);
authenticate.provider.addToRolePolicy(cognitoPolicy);

// The vendor IdP ID token: aud = client id, iss = the pool's issuer URL.
const token = authenticate.getAttString('AuthenticationResult.IdToken');
const authHeaders = {
  'Authorization': `Bearer ${token}`,
  'Content-Type': 'application/json',
};

// 2. Applications (ADR-032). The generated validators reject an incomplete
//    definition and an id outside the charset before the handler runs.
const putApplicationMissingScript = integ.assertions
  .httpApiCall(`${apiUrl}applications/${APP_X}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ ...definition, cellScripts: { create: definition.cellScripts.create, update: definition.cellScripts.update } }),
  })
  .expect(ExpectedResult.objectLike({ status: 400 }));
const putApplicationBadId = integ.assertions
  .httpApiCall(`${apiUrl}applications/Integ_X`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify(definition),
  })
  .expect(ExpectedResult.objectLike({ status: 400 }));

const putApplicationX = integ.assertions
  .httpApiCall(`${apiUrl}applications/${APP_X}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify(definition),
  })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: { application: { applicationId: APP_X, maxTenants: 1, placementStrategy: 'FILL', cellCount: 0 } },
    }),
  );
const putApplicationY = integ.assertions
  .httpApiCall(`${apiUrl}applications/${APP_Y}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify(definition),
  })
  .expect(ExpectedResult.objectLike({ status: 200, body: { application: { applicationId: APP_Y, cellCount: 0 } } }));

// ListApplications sorts by id (the GSI-1 sort key). Exact-length match.
const listApplicationsTwo = integ.assertions
  .httpApiCall(`${apiUrl}applications`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: { applications: [{ applicationId: APP_X, cellCount: 0 }, { applicationId: APP_Y, cellCount: 0 }] },
    }),
  );

// An allowlist may name registered applications only (ADR-033) — checked
// before the handshake, so no AssumeRole is attempted.
const putAccountUnknownApplication = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountA}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ owner: 'VENDOR', maxCells: 2, applicationIds: ['integ-nope'] }),
  })
  .expect(ExpectedResult.objectLike({ status: 404 }));

// 3. Accounts (ADR-024, ADR-027, ADR-033). The handshake is checked before any write:
//    an account with no role pair is refused with a 400 naming the role.
const putUnregisteredAccount = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${unregisteredAccount}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ owner: 'VENDOR', maxCells: 1 }),
  })
  .expect(ExpectedResult.objectLike({ status: 400 }));

// A's pair was installed WITHOUT an external id, so it admits an AssumeRole
// that omits one. Registering A with an external id (as if it were a
// customer's account) must be refused by the probe's negative call: the
// pair does not require the id it was given (ADR-030). Comes before A's
// real registration so the refusal is the handshake, not an owner change.
const putAccountANotEnforcingExternalId = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountA}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ owner: 'TENANT', maxCells: 1, externalId: accountBExternalId }),
  })
  .expect(
    ExpectedResult.objectLike({
      status: 400,
      body: { message: Match.stringLikeRegexp('control-plane-cell-provisioning does not require the external id') },
    }),
  );

// Account A: the control plane's own account, vendor-owned, two cells,
// shared (no applicationIds: it admits every application, ADR-033). The
// control plane stack installed the pair here (R-25); no external id.
const putAccountA = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountA}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ owner: 'VENDOR', maxCells: 2 }),
  })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: { account: { accountId: accountA, owner: 'VENDOR', maxCells: 2, cellCount: 0, externalIdConfigured: false } },
    }),
  );

// A tenant-owned account must carry an external id (ADR-029): refused
// before the probe, so no AssumeRole is attempted.
const putAccountBNoExternalId = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountB}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ owner: 'TENANT', maxCells: 1 }),
  })
  .expect(ExpectedResult.objectLike({ status: 400, body: { message: Match.stringLikeRegexp('externalId is required') } }));

// The wrong external id is refused by B's trust policy; the probe reports
// the role that refused (R-26).
const putAccountBWrongExternalId = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountB}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ owner: 'TENANT', maxCells: 1, externalId: `${accountBExternalId}-wrong` }),
  })
  .expect(
    ExpectedResult.objectLike({
      status: 400,
      body: { message: Match.stringLikeRegexp('control-plane-(cell|tenant)-provisioning could not be assumed') },
    }),
  );

// Account B: a customer's account, tenant-owned, one cell, external id,
// dedicated to Y (ADR-033).
const putAccountB = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountB}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ owner: 'TENANT', maxCells: 1, externalId: accountBExternalId, applicationIds: [APP_Y] }),
  })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: { account: { accountId: accountB, owner: 'TENANT', maxCells: 1, cellCount: 0, externalIdConfigured: true, applicationIds: [APP_Y] } },
    }),
  );

// ListAccounts sorts by account id (the GSI-1 sort key); both ids are known
// at synth time, so the expected order is too. Exact-length match.
const accountsInListOrder = [accountA, accountB].sort();
const listAccountsTwo = integ.assertions
  .httpApiCall(`${apiUrl}accounts`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: {
        accounts: accountsInListOrder.map((accountId) => ({
          accountId,
          cellCount: 0,
          maxCells: accountId === accountA ? 2 : 1,
        })),
      },
    }),
  );


// 4. Tenants are synchronous (§5.1): three records, no cell, no build.
//    T3 is deleted again straight away (empty-only delete, 200), and a
//    deployment for it is then a 404 — like one for an unregistered
//    application.
const createTenant1 = integ.assertions.httpApiCall(`${apiUrl}tenants`, {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({ name: 'integ-tenant-1', description: 'created by the integ test' }),
});
// Note: no .expect() on calls whose attributes are read with getAttString -
// combining both on one HttpApiCall is unsupported (response flattening
// breaks the internal assertion path). The contract is verified by the
// reads that follow.
const tenantId1 = createTenant1.getAttString('body.tenant.tenantId');

const createTenant2 = integ.assertions.httpApiCall(`${apiUrl}tenants`, {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({ name: 'integ-tenant-2' }),
});
const tenantId2 = createTenant2.getAttString('body.tenant.tenantId');

const createTenant3 = integ.assertions.httpApiCall(`${apiUrl}tenants`, {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({ name: 'integ-tenant-3' }),
});
const tenantId3 = createTenant3.getAttString('body.tenant.tenantId');

const getTenant1Empty = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: { tenant: { tenantId: tenantId1, name: 'integ-tenant-1', deploymentCount: 0 } },
    }),
  );

// ListTenants sorts by tenant id (the GSI-2 sort key, a ULID, so creation
// order). Exact-length match: three tenants, no cell anywhere yet.
const listTenantsThree = integ.assertions
  .httpApiCall(`${apiUrl}tenants`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: { tenants: [{ tenantId: tenantId1 }, { tenantId: tenantId2 }, { tenantId: tenantId3 }] },
    }),
  );
const listCellsNone = integ.assertions
  .httpApiCall(`${apiUrl}cells`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { cells: [] } }));

const updateTenant3 = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId3}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ description: 'about to be deleted' }),
  })
  .expect(ExpectedResult.objectLike({ status: 200, body: { tenant: { description: 'about to be deleted', deploymentCount: 0 } } }));

const deleteTenant3Empty = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId3}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { tenant: { tenantId: tenantId3 } } }));

const deployForDeletedTenant = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId3}/deployments`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ applicationId: APP_X, adminEmail: 'success+integ-t3@simulator.amazonses.com' }),
  })
  .expect(ExpectedResult.objectLike({ status: 404 }));

const deployUnregisteredApplication = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}/deployments`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ applicationId: 'integ-nope', adminEmail: 'success+integ-t1@simulator.amazonses.com' }),
  })
  .expect(ExpectedResult.objectLike({ status: 404 }));

// 5. Deploy X for T1 — CreateDeployment carries no resource definition
//    (P-4) and no accountId: placement considers the vendor-owned accounts
//    that admit X (A, shared), creates cell 1 in A implicitly and returns the
//    deployment CREATING with its cellId. Carries a clientToken for the
//    replay below.
const clientToken1 = 'integ-retry-token-t1-x';
const createT1XBody = JSON.stringify({
  applicationId: APP_X,
  adminEmail: 'success+integ-t1-x@simulator.amazonses.com',
  clientToken: clientToken1,
});
const createT1X = integ.assertions.httpApiCall(`${apiUrl}tenants/${tenantId1}/deployments`, {
  method: 'POST',
  headers: authHeaders,
  body: createT1XBody,
});
const cellId1 = createT1X.getAttString('body.deployment.cellId');

// Poll until the cell create build AND the tenant create build have run
// (one workflow execution, two builds — hence the doubled budget).
const waitForT1XActive = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}/deployments/${APP_X}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { deployment: { status: 'ACTIVE' } } }))
  .waitForAssertions(newCellPoll);

// GetDeployment resolves source + scripts from the cell's stamped definition
// (the cell's tenantScripts) and names the cell and its account (§5.2).
const getT1X = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}/deployments/${APP_X}`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: {
        deployment: { tenantId: tenantId1, applicationId: APP_X, cellId: cellId1, status: 'ACTIVE' },
        accountId: accountA,
        source: definition.source,
        scripts: definition.tenantScripts,
      },
    }),
  );

// GetCell returns the stamped definition, the application and the account.
const getCell1 = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId1}`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: {
        cell: {
          cellId: cellId1,
          applicationId: APP_X,
          accountId: accountA,
          status: 'ACTIVE',
          tenantCount: 1,
          maxTenants: 1,
          source: definition.source,
          cellScripts: definition.cellScripts,
          tenantScripts: definition.tenantScripts,
        },
      },
    }),
  );

// The three counters moved together (P-6): A 1/2, X 1 cell, T1 1 deployment.
const getAccountAOne = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountA}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { account: { cellCount: 1, maxCells: 2 } } }));
const getApplicationXOne = integ.assertions
  .httpApiCall(`${apiUrl}applications/${APP_X}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { application: { cellCount: 1 } } }));
const getTenant1One = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { tenant: { deploymentCount: 1 } } }));

// The cell's shared deployment published its namespace in A (the cell →
// tenant contract, §6.2) …
const checkCellParam = integ.assertions.awsApiCall('SSM', 'getParameter', {
  Name: `/application-plane/cells/${cellId1}/shared-endpoint`,
});
checkCellParam.provider.addToRolePolicy(ssmReadPolicy);
checkCellParam.expect(ExpectedResult.objectLike({ Parameter: { Type: 'String' } }));

// … and the tenant create script provisioned the per-deployment parameter
// in A, keyed by tenant AND application (ADR-037).
const checkT1XParam = integ.assertions.awsApiCall('SSM', 'getParameter', {
  Name: `/application-plane/tenants/${tenantId1}/${APP_X}`,
});
checkT1XParam.provider.addToRolePolicy(ssmReadPolicy);
checkT1XParam.expect(ExpectedResult.objectLike({ Parameter: { Type: 'String' } }));

// 6. One tenant, two applications: deploy Y for T1 without a target. Cell 1
//    belongs to X and is never a candidate for Y; B is tenant-owned and never
//    chosen untargeted; so cell 2 is created in A — A's second and last slot.
const createT1Y = integ.assertions.httpApiCall(`${apiUrl}tenants/${tenantId1}/deployments`, {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({ applicationId: APP_Y, adminEmail: 'success+integ-t1-y@simulator.amazonses.com' }),
});
const cellId2 = createT1Y.getAttString('body.deployment.cellId');

const waitForT1YActive = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}/deployments/${APP_Y}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { deployment: { status: 'ACTIVE', cellId: cellId2 } } }))
  .waitForAssertions(newCellPoll);

// A is full (2/2); Y has one cell; T1 has two deployments.
const getAccountAFull = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountA}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { account: { cellCount: 2, maxCells: 2 } } }));
const getApplicationYOne = integ.assertions
  .httpApiCall(`${apiUrl}applications/${APP_Y}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { application: { cellCount: 1 } } }));
const getTenant1Two = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { tenant: { deploymentCount: 2 } } }));

// Two cells of two applications in one account (ADR-032); the application
// filters split them.
const listCellsTwo = integ.assertions
  .httpApiCall(`${apiUrl}cells`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: {
        cells: [
          { cellId: cellId1, applicationId: APP_X, accountId: accountA, status: 'ACTIVE', tenantCount: 1 },
          { cellId: cellId2, applicationId: APP_Y, accountId: accountA, status: 'ACTIVE', tenantCount: 1 },
        ],
      },
    }),
  );
const listCellsOfX = integ.assertions
  .httpApiCall(`${apiUrl}cells?applicationId=${APP_X}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { cells: [{ cellId: cellId1, applicationId: APP_X }] } }));

// ListDeployments by tenant (a base-table query, §4.7) and by application.
const listDeploymentsOfT1 = integ.assertions
  .httpApiCall(`${apiUrl}deployments?tenantId=${tenantId1}`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: {
        deployments: [
          { tenantId: tenantId1, applicationId: APP_X, cellId: cellId1 },
          { tenantId: tenantId1, applicationId: APP_Y, cellId: cellId2 },
        ],
      },
    }),
  );
const listDeploymentsOfX = integ.assertions
  .httpApiCall(`${apiUrl}deployments?applicationId=${APP_X}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { deployments: [{ tenantId: tenantId1, applicationId: APP_X }] } }));

// Each cell's scripts read THEIR application's shared namespace (ADR-034):
// the shared-endpoint carries the base domain the demo published per
// application. T1's two deployments wrote disjoint tenant namespaces.
const checkCell1SharedX = integ.assertions.awsApiCall('SSM', 'getParameter', {
  Name: `/application-plane/cells/${cellId1}/shared-endpoint`,
});
checkCell1SharedX.provider.addToRolePolicy(ssmReadPolicy);
checkCell1SharedX.expect(ExpectedResult.objectLike({ Parameter: { Value: Match.stringLikeRegexp(`\\.${APP_X}\\.cells\\.example\\.com$`) } }));
const checkCell2SharedY = integ.assertions.awsApiCall('SSM', 'getParameter', {
  Name: `/application-plane/cells/${cellId2}/shared-endpoint`,
});
checkCell2SharedY.provider.addToRolePolicy(ssmReadPolicy);
checkCell2SharedY.expect(ExpectedResult.objectLike({ Parameter: { Value: Match.stringLikeRegexp(`\\.${APP_Y}\\.cells\\.example\\.com$`) } }));
const checkT1Namespace = integ.assertions
  .awsApiCall('SSM', 'getParameters', {
    Names: [`/application-plane/tenants/${tenantId1}/${APP_X}`, `/application-plane/tenants/${tenantId1}/${APP_Y}`],
  })
  .expect(ExpectedResult.objectLike({ Parameters: [{ Type: 'String' }, { Type: 'String' }], InvalidParameters: [] }));
checkT1Namespace.provider.addToRolePolicy(ssmReadPolicy);

// A second deployment of X for T1 → 409 (one per tenant per application,
// ADR-037); deleting the tenant while it has deployments → 409.
const createT1XAgain = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}/deployments`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ applicationId: APP_X, adminEmail: 'success+integ-t1-x@simulator.amazonses.com' }),
  })
  .expect(ExpectedResult.objectLike({ status: 409, headers: { 'x-amzn-errortype': ['ConflictError'] } }));
const deleteTenant1Occupied = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 409 }));

// 7. Replay the IDENTICAL request (same clientToken, same parameters): the
//    original deployment comes back — same cell, and already ACTIVE, which a
//    fresh create could never be (it would start CREATING). No new
//    deployment, no new cell, no slot (ADR-017). The token with a different
//    applicationId is a request-hash mismatch → 409.
const replayT1X = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}/deployments`, {
    method: 'POST',
    headers: authHeaders,
    body: createT1XBody,
  })
  .expect(
    ExpectedResult.objectLike({
      status: 202,
      body: { deployment: { tenantId: tenantId1, applicationId: APP_X, cellId: cellId1, status: 'ACTIVE' } },
    }),
  );
const reuseTokenMismatch = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}/deployments`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      applicationId: APP_Y,
      adminEmail: 'success+integ-t1-x@simulator.amazonses.com',
      clientToken: clientToken1,
    }),
  })
  .expect(ExpectedResult.objectLike({ status: 409 }));
const getAccountAStillTwo = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountA}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { account: { cellCount: 2 } } }));
const getTenant1StillTwo = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { tenant: { deploymentCount: 2 } } }));

// 8. Fleet full for X (§7 step 0): A is full and B is tenant-owned, so an
//    untargeted deployment is a 409 InsufficientCapacityError and writes
//    nothing (R-28, ADR-026).
const createT2XUntargeted = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}/deployments`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ applicationId: APP_X, adminEmail: 'success+integ-t2-x@simulator.amazonses.com' }),
  })
  // The error TYPE tells it apart from a ConflictError 409 (ADR-026).
  .expect(ExpectedResult.objectLike({ status: 409, headers: { 'x-amzn-errortype': ['InsufficientCapacityError'] } }));

// 9. Admission (ADR-033): B admits only Y, so X targeted at B is a 400 — a
//    wrong account, not a full one.
const createT2XAtB = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}/deployments`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ applicationId: APP_X, adminEmail: 'success+integ-t2-x@simulator.amazonses.com', accountId: accountB }),
  })
  .expect(ExpectedResult.objectLike({ status: 400, body: { message: Match.stringLikeRegexp('does not admit application') } }));

const listCellsStillTwo = integ.assertions
  .httpApiCall(`${apiUrl}cells`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { cells: [{ cellId: cellId1 }, { cellId: cellId2 }] } }));
const getTenant2StillEmpty = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { tenant: { deploymentCount: 0 } } }));

// 10. Deploy Y for T2 INTO account B: the only way into a tenant-owned
//     account is to name it. Cell 3 is created there; the cell and tenant
//     builds assume B's provisioning role pair with the external id (ADR-025).
const createT2Y = integ.assertions.httpApiCall(`${apiUrl}tenants/${tenantId2}/deployments`, {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({ applicationId: APP_Y, adminEmail: 'success+integ-t2-y@simulator.amazonses.com', accountId: accountB }),
});
const cellId3 = createT2Y.getAttString('body.deployment.cellId');

// In-flight guard: T2/Y is CREATING (its cell + tenant builds take minutes;
// this call fires within seconds) — a mutation must 409 (§5.6).
const deleteWhileCreating = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}/deployments/${APP_Y}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 409 }));

const waitForT2YActive = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}/deployments/${APP_Y}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { deployment: { status: 'ACTIVE' } } }))
  .waitForAssertions(newCellPoll);

const getCell3 = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId3}`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: { cell: { cellId: cellId3, applicationId: APP_Y, accountId: accountB, status: 'ACTIVE', tenantCount: 1, maxTenants: 1 } },
    }),
  );

// The scripts ran IN account B: the cell namespace (two parameters:
// shared-endpoint and provisioned) and the deployment parameter exist there …
const probeCell3InB = probeB('ProbeCell3InB', { path: `/application-plane/cells/${cellId3}` })
  .expect(ExpectedResult.objectLike({ Payload: '2' }));
const probeT2YInB = probeB('ProbeT2YInB', { names: [`/application-plane/tenants/${tenantId2}/${APP_Y}`] })
  .expect(ExpectedResult.objectLike({ Payload: '1' }));

// … and NOT in A. GetParameters (plural) reports a missing name in
// InvalidParameters instead of throwing.
const checkCell3NotInA = integ.assertions
  .awsApiCall('SSM', 'getParameters', {
    Names: [`/application-plane/cells/${cellId3}/shared-endpoint`, `/application-plane/tenants/${tenantId2}/${APP_Y}`],
  })
  .expect(
    ExpectedResult.objectLike({
      Parameters: [],
      InvalidParameters: [`/application-plane/cells/${cellId3}/shared-endpoint`, `/application-plane/tenants/${tenantId2}/${APP_Y}`],
    }),
  );
checkCell3NotInA.provider.addToRolePolicy(ssmReadPolicy);

const getAccountBFull = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountB}`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: { account: { cellCount: 1, maxCells: 1, externalIdConfigured: true, applicationIds: [APP_Y] } },
    }),
  );
const getApplicationYTwo = integ.assertions
  .httpApiCall(`${apiUrl}applications/${APP_Y}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { application: { cellCount: 2 } } }));

// 11. Account B is full: a targeted deployment → 409 InsufficientCapacity;
//     deregistering an occupied account or application → 409; changing B's
//     owner → 409. T4 is created for the attempt and deleted again.
const createTenant4 = integ.assertions.httpApiCall(`${apiUrl}tenants`, {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({ name: 'integ-tenant-4' }),
});
const tenantId4 = createTenant4.getAttString('body.tenant.tenantId');

const createT4YAtFullB = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId4}/deployments`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ applicationId: APP_Y, adminEmail: 'success+integ-t4-y@simulator.amazonses.com', accountId: accountB }),
  })
  .expect(ExpectedResult.objectLike({ status: 409, headers: { 'x-amzn-errortype': ['InsufficientCapacityError'] } }));

const deleteAccountBOccupied = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountB}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 409 }));
const deleteApplicationYOccupied = integ.assertions
  .httpApiCall(`${apiUrl}applications/${APP_Y}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 409 }));
const putAccountBOwnerChange = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountB}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ owner: 'VENDOR', maxCells: 1, externalId: accountBExternalId, applicationIds: [APP_Y] }),
  })
  .expect(ExpectedResult.objectLike({ status: 409 }));
const deleteTenant4 = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId4}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200 }));

// 12. Reads. Three cells with their applications and accounts (ULID order);
//     the filters are query predicates (unknown id → empty page, two filters
//     → 400); a replaced definition leaves stamped cells alone (P-4).
const listCellsThree = integ.assertions
  .httpApiCall(`${apiUrl}cells`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: {
        cells: [
          { cellId: cellId1, applicationId: APP_X, accountId: accountA },
          { cellId: cellId2, applicationId: APP_Y, accountId: accountA },
          { cellId: cellId3, applicationId: APP_Y, accountId: accountB },
        ],
      },
    }),
  );
const listCellsInA = integ.assertions
  .httpApiCall(`${apiUrl}cells?accountId=${accountA}`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: { cells: [{ cellId: cellId1, accountId: accountA }, { cellId: cellId2, accountId: accountA }] },
    }),
  );
const listCellsUnknownAccount = integ.assertions
  .httpApiCall(`${apiUrl}cells?accountId=${unregisteredAccount}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { cells: [] } }));
const listCellsTwoFilters = integ.assertions
  .httpApiCall(`${apiUrl}cells?accountId=${accountA}&applicationId=${APP_X}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 400 }));

const listDeploymentsByCell1 = integ.assertions
  .httpApiCall(`${apiUrl}deployments?cellId=${cellId1}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { deployments: [{ tenantId: tenantId1, applicationId: APP_X, cellId: cellId1 }] } }));
const listDeploymentsOfY = integ.assertions
  .httpApiCall(`${apiUrl}deployments?applicationId=${APP_Y}`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: { deployments: [{ tenantId: tenantId1, applicationId: APP_Y }, { tenantId: tenantId2, applicationId: APP_Y }] },
    }),
  );
const listDeploymentsUnknownCell = integ.assertions
  .httpApiCall(`${apiUrl}deployments?cellId=${unknownCellId}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { deployments: [] } }));
const listDeploymentsTwoFilters = integ.assertions
  .httpApiCall(`${apiUrl}deployments?cellId=${cellId1}&applicationId=${APP_X}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 400 }));

// Metadata update (sync 200) never touches the count.
const updateTenant1 = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ description: 'updated by the integ test' }),
  })
  .expect(ExpectedResult.objectLike({ status: 200, body: { tenant: { description: 'updated by the integ test', deploymentCount: 2 } } }));

// A replaced definition reaches only cells created afterwards (P-4): Y's
// maxTenants changes, cells 2 and 3 keep their stamp.
const putApplicationYReplaced = integ.assertions
  .httpApiCall(`${apiUrl}applications/${APP_Y}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ ...definition, maxTenants: 3, placementStrategy: 'ROUND_ROBIN' }),
  })
  .expect(ExpectedResult.objectLike({ status: 200, body: { application: { maxTenants: 3, placementStrategy: 'ROUND_ROBIN', cellCount: 2 } } }));
const getCell3StillStamped = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId3}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { cell: { maxTenants: 1 } } }));
const getCell2StillStamped = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId2}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { cell: { maxTenants: 1 } } }));

// 13. Re-apply across accounts: T1/X in A (202 → ACTIVE) and the shared
//     cell deployment of cell 3 in B (202 → ACTIVE) — the update scripts run
//     under the respective account's provisioning role with APPLICATION_ID set.
const updateT1X = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}/deployments/${APP_X}`, { method: 'PUT', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 202, body: { deployment: { status: 'UPDATING' } } }));
const waitForT1XUpdated = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}/deployments/${APP_X}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { deployment: { status: 'ACTIVE' } } }))
  .waitForAssertions(singleBuildPoll);

const updateCell3 = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId3}`, { method: 'PUT', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 202, body: { cell: { status: 'UPDATING' } } }));
const waitForCell3Updated = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId3}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { cell: { status: 'ACTIVE' } } }))
  .waitForAssertions(singleBuildPoll);

// 14. Occupancy guard: deleting a cell that still holds a deployment → 409
//     (ADR-014). Then delete T1/X: the record disappears when the tenant
//     delete script has run and the terminal transaction freed the CELL slot
//     and the TENANT count — not the account's: cell 1 stays (explicit
//     scale-in, ADR-014), A stays 2/2 and X stays at one cell.
const deleteCellOccupied = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId1}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 409 }));

const deleteT1X = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}/deployments/${APP_X}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 202, body: { deployment: { status: 'DELETING' } } }));
const waitForT1XGone = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}/deployments/${APP_X}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 404 }))
  .waitForAssertions(singleBuildPoll);

const getCell1SlotFreed = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId1}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { cell: { status: 'ACTIVE', tenantCount: 0, maxTenants: 1 } } }));
const getAccountAStillFull = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountA}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { account: { cellCount: 2, maxCells: 2 } } }));
const getApplicationXStillOne = integ.assertions
  .httpApiCall(`${apiUrl}applications/${APP_X}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { application: { cellCount: 1 } } }));
const getTenant1OneAgain = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { tenant: { deploymentCount: 1 } } }));

const checkT1XParamGone = integ.assertions
  .awsApiCall('SSM', 'getParameters', { Names: [`/application-plane/tenants/${tenantId1}/${APP_X}`] })
  .expect(ExpectedResult.objectLike({ Parameters: [], InvalidParameters: [`/application-plane/tenants/${tenantId1}/${APP_X}`] }));
checkT1XParamGone.provider.addToRolePolicy(ssmReadPolicy);

// Reuse before create (§7 steps 1–2): deploying X for T2 without a target
// now finds the empty cell 1 and places into it — no new cell, no 409, one
// build only.
const createT2X = integ.assertions.httpApiCall(`${apiUrl}tenants/${tenantId2}/deployments`, {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({ applicationId: APP_X, adminEmail: 'success+integ-t2-x@simulator.amazonses.com' }),
});
const waitForT2XActive = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}/deployments/${APP_X}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { deployment: { status: 'ACTIVE', cellId: cellId1 } } }))
  .waitForAssertions(singleBuildPoll);

// 15. Teardown. Delete the remaining deployments T2/X, T1/Y, T2/Y …
const deleteT2X = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}/deployments/${APP_X}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 202, body: { deployment: { status: 'DELETING' } } }));
const waitForT2XGone = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}/deployments/${APP_X}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 404 }))
  .waitForAssertions(singleBuildPoll);

const deleteT1Y = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}/deployments/${APP_Y}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 202, body: { deployment: { status: 'DELETING' } } }));
const waitForT1YGone = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}/deployments/${APP_Y}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 404 }))
  .waitForAssertions(singleBuildPoll);

const deleteT2Y = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}/deployments/${APP_Y}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 202, body: { deployment: { status: 'DELETING' } } }));
const waitForT2YGone = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}/deployments/${APP_Y}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 404 }))
  .waitForAssertions(singleBuildPoll);

// … every tenant's count is back at 0 and no per-deployment parameter
// remains, in either account …
const getTenant1Zero = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { tenant: { deploymentCount: 0 } } }));
const getTenant2Zero = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { tenant: { deploymentCount: 0 } } }));
const checkTenantNamespaceEmptyA = integ.assertions
  .awsApiCall('SSM', 'getParametersByPath', { Path: '/application-plane/tenants', Recursive: true })
  .expect(ExpectedResult.objectLike({ Parameters: [] }));
checkTenantNamespaceEmptyA.provider.addToRolePolicy(ssmReadPolicy);
const probeTenantNamespaceEmptyB = probeB('ProbeTenantsEmptyB', { path: '/application-plane/tenants' })
  .expect(ExpectedResult.objectLike({ Payload: '0' }));

// … deprovision the three (now empty) cells; each record disappears when
// the cell delete script has run and the terminal transaction released the
// account's slot and the application's count (ADR-024, ADR-032) …
const deleteCell1 = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId1}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 202, body: { cell: { status: 'DELETING' } } }));
const waitForCell1Gone = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId1}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 404 }))
  .waitForAssertions(singleBuildPoll);

const deleteCell2 = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId2}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 202, body: { cell: { status: 'DELETING' } } }));
const waitForCell2Gone = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId2}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 404 }))
  .waitForAssertions(singleBuildPoll);

const deleteCell3 = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId3}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 202, body: { cell: { status: 'DELETING' } } }));
const waitForCell3Gone = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId3}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 404 }))
  .waitForAssertions(singleBuildPoll);

// … both accounts and both applications are empty again, the fleet has no
// cells, and the cell delete scripts cleaned their namespaces in both
// accounts …
const getAccountAEmpty = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountA}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { account: { cellCount: 0, maxCells: 2 } } }));
const getAccountBEmpty = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountB}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { account: { cellCount: 0, maxCells: 1 } } }));
const listApplicationsEmptyCounts = integ.assertions
  .httpApiCall(`${apiUrl}applications`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: { applications: [{ applicationId: APP_X, cellCount: 0 }, { applicationId: APP_Y, cellCount: 0 }] },
    }),
  );
const listCellsEmpty = integ.assertions
  .httpApiCall(`${apiUrl}cells`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { cells: [] } }));
const checkCellNamespacesEmptyA = integ.assertions
  .awsApiCall('SSM', 'getParametersByPath', { Path: '/application-plane/cells', Recursive: true })
  .expect(ExpectedResult.objectLike({ Parameters: [] }));
checkCellNamespacesEmptyA.provider.addToRolePolicy(ssmReadPolicy);
const probeCellNamespacesEmptyB = probeB('ProbeCellsEmptyB', { path: '/application-plane/cells' })
  .expect(ExpectedResult.objectLike({ Payload: '0' }));

// … and tenants, accounts and applications can be deleted (empty-only).
const deleteTenant1 = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { tenant: { tenantId: tenantId1 } } }));
const deleteTenant2 = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { tenant: { tenantId: tenantId2 } } }));
const deleteAccountA = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountA}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { account: { accountId: accountA } } }));
const deleteAccountB = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountB}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { account: { accountId: accountB } } }));
const deleteApplicationX = integ.assertions
  .httpApiCall(`${apiUrl}applications/${APP_X}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { application: { applicationId: APP_X } } }));
const deleteApplicationY = integ.assertions
  .httpApiCall(`${apiUrl}applications/${APP_Y}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { application: { applicationId: APP_Y } } }));

const listTenantsEmpty = integ.assertions
  .httpApiCall(`${apiUrl}tenants`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { tenants: [] } }));
const listAccountsEmpty = integ.assertions
  .httpApiCall(`${apiUrl}accounts`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { accounts: [] } }));
const listApplicationsEmpty = integ.assertions
  .httpApiCall(`${apiUrl}applications`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { applications: [] } }));

// Sequence the lifecycle strictly (references alone order most of it, but
// the reads/guards must not race the polls, and the in-flight 409 must fire
// while T2/Y is still CREATING).
createUser
  .next(randomPassword)
  .next(setPassword)
  .next(authenticate)
  // applications (§10 step 2)
  .next(putApplicationMissingScript)
  .next(putApplicationBadId)
  .next(putApplicationX)
  .next(putApplicationY)
  .next(listApplicationsTwo)
  .next(putAccountUnknownApplication)
  // accounts (step 3)
  .next(putUnregisteredAccount)
  .next(putAccountANotEnforcingExternalId)
  .next(putAccountA)
  .next(putAccountBNoExternalId)
  .next(putAccountBWrongExternalId)
  .next(putAccountB)
  .next(listAccountsTwo)
  // tenants are synchronous (step 4)
  .next(createTenant1)
  .next(createTenant2)
  .next(createTenant3)
  .next(getTenant1Empty)
  .next(listTenantsThree)
  .next(listCellsNone)
  .next(updateTenant3)
  .next(deleteTenant3Empty)
  .next(deployForDeletedTenant)
  .next(deployUnregisteredApplication)
  // T1/X → cell 1 in A (step 5)
  .next(createT1X)
  .next(waitForT1XActive)
  .next(getT1X)
  .next(getCell1)
  .next(getAccountAOne)
  .next(getApplicationXOne)
  .next(getTenant1One)
  .next(checkCellParam)
  .next(checkT1XParam)
  // T1/Y → cell 2 in A; one tenant, two applications (step 6)
  .next(createT1Y)
  .next(waitForT1YActive)
  .next(getAccountAFull)
  .next(getApplicationYOne)
  .next(getTenant1Two)
  .next(listCellsTwo)
  .next(listCellsOfX)
  .next(listDeploymentsOfT1)
  .next(listDeploymentsOfX)
  .next(checkCell1SharedX)
  .next(checkCell2SharedY)
  .next(checkT1Namespace)
  .next(createT1XAgain)
  .next(deleteTenant1Occupied)
  // replay + mismatch (step 7, ADR-017)
  .next(replayT1X)
  .next(reuseTokenMismatch)
  .next(getAccountAStillTwo)
  .next(getTenant1StillTwo)
  // fleet full for X (step 8), admission (step 9)
  .next(createT2XUntargeted)
  .next(createT2XAtB)
  .next(listCellsStillTwo)
  .next(getTenant2StillEmpty)
  // T2/Y → cell 3 in B (step 10, + in-flight guard)
  .next(createT2Y)
  .next(deleteWhileCreating)
  .next(waitForT2YActive)
  .next(getCell3)
  .next(probeCell3InB)
  .next(probeT2YInB)
  .next(checkCell3NotInA)
  .next(getAccountBFull)
  .next(getApplicationYTwo)
  // B full (step 11)
  .next(createTenant4)
  .next(createT4YAtFullB)
  .next(deleteAccountBOccupied)
  .next(deleteApplicationYOccupied)
  .next(putAccountBOwnerChange)
  .next(deleteTenant4)
  // reads (step 12)
  .next(listCellsThree)
  .next(listCellsInA)
  .next(listCellsUnknownAccount)
  .next(listCellsTwoFilters)
  .next(listDeploymentsByCell1)
  .next(listDeploymentsOfY)
  .next(listDeploymentsUnknownCell)
  .next(listDeploymentsTwoFilters)
  .next(updateTenant1)
  .next(putApplicationYReplaced)
  .next(getCell3StillStamped)
  .next(getCell2StillStamped)
  // re-apply in A and in B (step 13)
  .next(updateT1X)
  .next(waitForT1XUpdated)
  .next(updateCell3)
  .next(waitForCell3Updated)
  // guards, delete T1/X, reuse cell 1 for T2/X (step 14)
  .next(deleteCellOccupied)
  .next(deleteT1X)
  .next(waitForT1XGone)
  .next(getCell1SlotFreed)
  .next(getAccountAStillFull)
  .next(getApplicationXStillOne)
  .next(getTenant1OneAgain)
  .next(checkT1XParamGone)
  .next(createT2X)
  .next(waitForT2XActive)
  // teardown (step 15)
  .next(deleteT2X)
  .next(waitForT2XGone)
  .next(deleteT1Y)
  .next(waitForT1YGone)
  .next(deleteT2Y)
  .next(waitForT2YGone)
  .next(getTenant1Zero)
  .next(getTenant2Zero)
  .next(checkTenantNamespaceEmptyA)
  .next(probeTenantNamespaceEmptyB)
  .next(deleteCell1)
  .next(waitForCell1Gone)
  .next(deleteCell2)
  .next(waitForCell2Gone)
  .next(deleteCell3)
  .next(waitForCell3Gone)
  .next(getAccountAEmpty)
  .next(getAccountBEmpty)
  .next(listApplicationsEmptyCounts)
  .next(listCellsEmpty)
  .next(checkCellNamespacesEmptyA)
  .next(probeCellNamespacesEmptyB)
  .next(deleteTenant1)
  .next(deleteTenant2)
  .next(deleteAccountA)
  .next(deleteAccountB)
  .next(deleteApplicationX)
  .next(deleteApplicationY)
  .next(listTenantsEmpty)
  .next(listAccountsEmpty)
  .next(listApplicationsEmpty);

/** Reads a required environment variable or fails synth with the reason it is needed. */
function requireEnv(name: string, purpose: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} must be set: ${purpose}`);
  }
  return value;
}
