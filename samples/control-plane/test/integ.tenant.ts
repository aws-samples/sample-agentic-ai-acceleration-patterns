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
import { CellDefinition, TenantStack } from '../src/tenant/tenant.cdk';

/**
 * End-to-end integration test for the cell-based control plane across TWO
 * accounts (spec §10, ADR-024..027).
 *
 * Accounts: A is the account the test runs in (the control plane's own,
 * registered as vendor-owned with room for two cells); B is a second
 * account, named by `CP_INTEG_ACCOUNT_B`, registered as tenant-owned with
 * room for one cell and an external id. B must be CDK-bootstrapped trusting
 * A (`cdk bootstrap aws://<B>/<region> --trust <A>`), because this app
 * deploys the account role pair into B with A's credentials.
 *
 * Setup (in A): a throwaway Cognito user pool acts as the vendor IdP (its ID
 * tokens carry iss + aud, which the authorizer validates via OIDC discovery,
 * plus the `role: "operator"` claim ADR-018 requires, added by a pre token
 * generation trigger); the sample cell + tenant scripts are hosted in an S3
 * bucket used as the stamped CodeBuild ProjectSource; and a probe Lambda
 * that assumes a read-only role in B to count SSM parameters there (the
 * assertion provider itself runs in A only). maxTenants = 1: every cell is a
 * silo, so cells — not tenants — are what the accounts count.
 *
 * Flow (every API operation is exercised):
 *   1. unauthenticated request → 401
 *   2. mint an operator: adminCreateUser → adminSetUserPassword →
 *      adminInitiateAuth → ID token
 *   3. PutAccount for an account with no role pair → 400 (handshake);
 *      PutAccount A as TENANT with an external id its pair does not
 *      require → 400 naming the role (ADR-030);
 *      PutAccount B as TENANT without an external id → 400 (ADR-029), with
 *      the wrong one → 400 naming the role;
 *      PutAccount A (VENDOR, 2) and B (TENANT, 1, external id) → 200;
 *      ListAccounts shows both at 0/n; GetAccount B hides the external id
 *   4. CreateTenant #1 (clientToken) → cell 1 in A → poll ACTIVE; the cell
 *      namespace and tenant parameter exist in A; account A is 1/2;
 *      replaying the identical request returns the SAME tenant (ADR-017);
 *      the token with different parameters → 409; still one cell
 *   5. CreateTenant #2 → cell 2 in A (cell 1 is full); account A is 2/2
 *   6. CreateTenant #3 untargeted → 409 InsufficientCapacity (A full, B is
 *      tenant-owned); still two cells
 *   7. CreateTenant #3 targeted at B → cell 3 in B; an in-flight
 *      DeleteTenant while CREATING → 409; poll ACTIVE; GetCell names B;
 *      the cell namespace and tenant parameter exist in B and not in A;
 *      account B is 1/1
 *   8. CreateTenant #4 targeted at B → 409 (full); DeleteAccount B → 409
 *      (occupied); PutAccount B with another owner → 409
 *   9. reads: ListCells (three cells with accountId), ListCells?accountId=A
 *      (cells 1 and 2), unknown account → empty page; ListTenants?cellId=;
 *      GetResource names cell and account; UpdateTenant edits metadata
 *  10. UpdateResource #1 (in A) and UpdateCell cell 3 (in B) → ACTIVE
 *  11. DeleteCell on the occupied cell 1 → 409; DeleteTenant #1 → 404;
 *      cell 1 stays at 0/1 and account A stays 2/2; CreateTenant #5
 *      untargeted reuses cell 1 (no new cell)
 *  12. DeleteTenant #5, #2, #3 → 404; tenant namespaces empty in A and B;
 *      DeleteCell 1, 2, 3 → 404; A → 0/2, B → 0/1; cell namespaces empty
 *      in both accounts; DeleteAccount A and B → 200; ListAccounts empty
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
  // The sample cell script reads the demo shared parameter (ADR-010).
  demoSharedParameters: true,
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
// The deployment-configured CellDefinition (§10) — stamped onto every cell
// this test creates. maxTenants = 1: every cell is a silo, so the account
// cell limits are what fill up.
const cellDefinition: CellDefinition = {
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
  cellDefinition,
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

// 2. Mint an operator identity in the vendor IdP.
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

// 3. Accounts (ADR-024, ADR-027). The handshake is checked before any write:
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

// Account A: the control plane's own account, vendor-owned, two cells. The
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

// Account B: a customer's account, tenant-owned, one cell, external id.
const putAccountB = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountB}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ owner: 'TENANT', maxCells: 1, externalId: accountBExternalId }),
  })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: { account: { accountId: accountB, owner: 'TENANT', maxCells: 1, cellCount: 0, externalIdConfigured: true } },
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

// 4. Onboard tenant #1 — CreateTenant carries no resource definition (§5)
//    and no accountId: placement considers vendor-owned accounts only,
//    creates the first cell in A implicitly, and returns the tenant
//    CREATING with its cellId. Carries a clientToken for the replay below.
const clientToken1 = 'integ-retry-token-tenant-1';
const createTenant1Body = JSON.stringify({
  name: 'integ-tenant-1',
  description: 'created by the integ test',
  adminEmail: 'success+integ-tenant-1@simulator.amazonses.com',
  clientToken: clientToken1,
});
const createTenant1 = integ.assertions.httpApiCall(`${apiUrl}tenants`, {
  method: 'POST',
  headers: authHeaders,
  body: createTenant1Body,
});
// Note: no .expect() here - combining expect() with getAttString() on the
// same HttpApiCall is unsupported (response flattening breaks the internal
// assertion path). The 202/CREATING contract is implicitly verified by the
// ACTIVE poll below, which can only succeed if creation started.
const tenantId1 = createTenant1.getAttString('body.tenant.tenantId');
const cellId1 = createTenant1.getAttString('body.tenant.cellId');

// Poll until the cell create build AND the tenant create build have run
// (one workflow execution, two builds — hence the doubled budget).
const waitForActive1 = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { tenant: { status: 'ACTIVE' } } }))
  .waitForAssertions(newCellPoll);

// Exactly one cell: in A, ACTIVE, its one slot occupied. The plain array in
// the pattern is matched exact-length, element-wise (deep-partial per
// element) — one element asserts "exactly one cell".
const listCellsOne = integ.assertions
  .httpApiCall(`${apiUrl}cells`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: { cells: [{ cellId: cellId1, accountId: accountA, status: 'ACTIVE', tenantCount: 1, maxTenants: 1 }] },
    }),
  );

// GetCell returns the stamped definition (ADR-012) and the account (ADR-024).
const getCell1 = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId1}`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: {
        cell: {
          cellId: cellId1,
          accountId: accountA,
          status: 'ACTIVE',
          tenantCount: 1,
          maxTenants: 1,
          source: cellDefinition.source,
          cellScripts: cellDefinition.cellScripts,
          tenantScripts: cellDefinition.tenantScripts,
        },
      },
    }),
  );

// The account claim landed with the cell (ADR-024).
const getAccountAOne = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountA}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { account: { cellCount: 1, maxCells: 2 } } }));

// The cell's shared deployment published its namespace in A (the cell →
// tenant contract, §6.2) …
const checkCellParam = integ.assertions.awsApiCall('SSM', 'getParameter', {
  Name: `/application-plane/cells/${cellId1}/shared-endpoint`,
});
checkCellParam.provider.addToRolePolicy(ssmReadPolicy);
checkCellParam.expect(ExpectedResult.objectLike({ Parameter: { Type: 'String' } }));

// … and the tenant create script provisioned the per-tenant deployment in A.
const checkTenantParam1 = integ.assertions.awsApiCall('SSM', 'getParameter', {
  Name: `/application-plane/tenants/${tenantId1}`,
});
checkTenantParam1.provider.addToRolePolicy(ssmReadPolicy);
checkTenantParam1.expect(ExpectedResult.objectLike({ Parameter: { Type: 'String' } }));

// Replay the IDENTICAL request (same clientToken, same parameters): the
// original tenant comes back — same tenantId, and already ACTIVE, which a
// fresh onboard could never be (it would start CREATING). No new tenant,
// no new cell, no account slot (ADR-017).
const replayCreateTenant1 = integ.assertions
  .httpApiCall(`${apiUrl}tenants`, {
    method: 'POST',
    headers: authHeaders,
    body: createTenant1Body,
  })
  .expect(
    ExpectedResult.objectLike({
      status: 202,
      body: { tenant: { tenantId: tenantId1, cellId: cellId1, status: 'ACTIVE' } },
    }),
  );

// Reusing the token with DIFFERENT parameters is a request-hash mismatch → 409.
const reuseTokenMismatch = integ.assertions
  .httpApiCall(`${apiUrl}tenants`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'integ-tenant-1-different',
      adminEmail: 'success+integ-tenant-1@simulator.amazonses.com',
      clientToken: clientToken1,
    }),
  })
  .expect(ExpectedResult.objectLike({ status: 409 }));

// Still exactly one cell and A still 1/2. Sequenced AFTER the replay and
// the mismatch: neither may have claimed a slot or created a cell.
const listCellsStillOne = integ.assertions
  .httpApiCall(`${apiUrl}cells`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: { cells: [{ cellId: cellId1, status: 'ACTIVE', tenantCount: 1, maxTenants: 1 }] },
    }),
  );

// 5. Onboard tenant #2 — cell 1 is full, so placement creates cell 2, in A
//    again (its second and last cell slot).
const createTenant2 = integ.assertions.httpApiCall(`${apiUrl}tenants`, {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({
    name: 'integ-tenant-2',
    adminEmail: 'success+integ-tenant-2@simulator.amazonses.com',
  }),
});
const tenantId2 = createTenant2.getAttString('body.tenant.tenantId');
const cellId2 = createTenant2.getAttString('body.tenant.cellId');

const waitForActive2 = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { tenant: { status: 'ACTIVE' } } }))
  .waitForAssertions(newCellPoll);

// Account A is now full (2/2); two cells, both in A, ULID order.
const getAccountAFull = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountA}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { account: { cellCount: 2, maxCells: 2 } } }));

const listCellsTwo = integ.assertions
  .httpApiCall(`${apiUrl}cells`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: {
        cells: [
          { cellId: cellId1, accountId: accountA, status: 'ACTIVE', tenantCount: 1 },
          { cellId: cellId2, accountId: accountA, status: 'ACTIVE', tenantCount: 1 },
        ],
      },
    }),
  );

// 6. Tenant-owned accounts are not fleet capacity (§7 step 0): with A full
//    and B tenant-owned, an untargeted onboard is a 409
//    InsufficientCapacityError and writes nothing (R-28, ADR-026).
const createTenant3Untargeted = integ.assertions
  .httpApiCall(`${apiUrl}tenants`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'integ-tenant-3',
      adminEmail: 'success+integ-tenant-3@simulator.amazonses.com',
    }),
  })
  // The error TYPE tells it apart from a ConflictError 409 (ADR-026); the
  // message names the full accounts and is not matched here.
  .expect(ExpectedResult.objectLike({ status: 409, headers: { 'x-amzn-errortype': ['InsufficientCapacityError'] } }));

const listCellsStillTwo = integ.assertions
  .httpApiCall(`${apiUrl}cells`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: { cells: [{ cellId: cellId1 }, { cellId: cellId2 }] },
    }),
  );

// 7. Onboard tenant #3 INTO account B: the only way into a tenant-owned
//    account is to name it. Cell 3 is created there; the cell and tenant
//    builds assume B's provisioning role pair with the external id (ADR-025).
const createTenant3 = integ.assertions.httpApiCall(`${apiUrl}tenants`, {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({
    name: 'integ-tenant-3',
    adminEmail: 'success+integ-tenant-3@simulator.amazonses.com',
    accountId: accountB,
  }),
});
const tenantId3 = createTenant3.getAttString('body.tenant.tenantId');
const cellId3 = createTenant3.getAttString('body.tenant.cellId');

// In-flight guard: tenant #3 is CREATING (its cell + tenant builds take
// minutes; this call fires within seconds) — a mutation must 409 (§5).
const deleteWhileCreating = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId3}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 409 }));

const waitForActive3 = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId3}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { tenant: { status: 'ACTIVE' } } }))
  .waitForAssertions(newCellPoll);

const getCell3 = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId3}`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: { cell: { cellId: cellId3, accountId: accountB, status: 'ACTIVE', tenantCount: 1, maxTenants: 1 } },
    }),
  );

// The scripts ran IN account B: the cell namespace (two parameters:
// shared-endpoint and provisioned) and the tenant parameter exist there …
const probeCell3InB = probeB('ProbeCell3InB', { path: `/application-plane/cells/${cellId3}` })
  .expect(ExpectedResult.objectLike({ Payload: '2' }));
const probeTenant3InB = probeB('ProbeTenant3InB', { names: [`/application-plane/tenants/${tenantId3}`] })
  .expect(ExpectedResult.objectLike({ Payload: '1' }));

// … and NOT in A. GetParameters (plural) reports a missing name in
// InvalidParameters instead of throwing.
const checkCell3NotInA = integ.assertions
  .awsApiCall('SSM', 'getParameters', {
    Names: [`/application-plane/cells/${cellId3}/shared-endpoint`, `/application-plane/tenants/${tenantId3}`],
  })
  .expect(
    ExpectedResult.objectLike({
      Parameters: [],
      InvalidParameters: [`/application-plane/cells/${cellId3}/shared-endpoint`, `/application-plane/tenants/${tenantId3}`],
    }),
  );
checkCell3NotInA.provider.addToRolePolicy(ssmReadPolicy);

const getAccountBFull = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountB}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { account: { cellCount: 1, maxCells: 1, externalIdConfigured: true } } }));

// 8. Account B is full: a targeted onboard → 409 InsufficientCapacity;
//    deregistering an occupied account → 409; changing its owner → 409.
const createTenant4AtFullB = integ.assertions
  .httpApiCall(`${apiUrl}tenants`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'integ-tenant-4',
      adminEmail: 'success+integ-tenant-4@simulator.amazonses.com',
      accountId: accountB,
    }),
  })
  .expect(ExpectedResult.objectLike({ status: 409, headers: { 'x-amzn-errortype': ['InsufficientCapacityError'] } }));

const deleteAccountBOccupied = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountB}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 409 }));

const putAccountBOwnerChange = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountB}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ owner: 'VENDOR', maxCells: 1, externalId: accountBExternalId }),
  })
  .expect(ExpectedResult.objectLike({ status: 409 }));

// 9. Reads. Three cells with their accounts (ULID order); ?accountId= is a
//    query predicate (unknown account → empty page, §5).
const listCellsThree = integ.assertions
  .httpApiCall(`${apiUrl}cells`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: {
        cells: [
          { cellId: cellId1, accountId: accountA },
          { cellId: cellId2, accountId: accountA },
          { cellId: cellId3, accountId: accountB },
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

// GetResource resolves source + scripts from the cell's stamped definition
// (the cell's tenantScripts) and names the cell and its account (§5).
const getResource1 = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}/resource`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: {
        status: 'ACTIVE',
        cellId: cellId1,
        accountId: accountA,
        source: cellDefinition.source,
        scripts: cellDefinition.tenantScripts,
      },
    }),
  );

// ListTenants?cellId= — exactly the cell's tenant.
const listTenantsByCell1 = integ.assertions
  .httpApiCall(`${apiUrl}tenants?cellId=${cellId1}`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: { tenants: [{ tenantId: tenantId1, cellId: cellId1 }] },
    }),
  );

// An unknown cellId is a query predicate miss — empty page, not a 404 (§5).
const listTenantsUnknownCell = integ.assertions
  .httpApiCall(`${apiUrl}tenants?cellId=${unknownCellId}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { tenants: [] } }));

// Metadata update (sync 200, reflected in GetTenant).
const updateTenant1 = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ description: 'updated by the integ test' }),
  })
  .expect(ExpectedResult.objectLike({ status: 200, body: { tenant: { status: 'ACTIVE' } } }));

const getTenant1Updated = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: { tenant: { description: 'updated by the integ test' } },
    }),
  );

// 10. Re-apply across accounts: the tenant deployment in A (202 → ACTIVE)
//     and the shared cell deployment in B (202 → ACTIVE) — the update
//     scripts run under the respective account's provisioning role.
const updateResource1 = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}/resource`, { method: 'PUT', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 202, body: { tenant: { status: 'UPDATING' } } }));

const waitForTenant1Updated = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { tenant: { status: 'ACTIVE' } } }))
  .waitForAssertions(singleBuildPoll);

const updateCell3 = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId3}`, { method: 'PUT', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 202, body: { cell: { status: 'UPDATING' } } }));

const waitForCell3Updated = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId3}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { cell: { status: 'ACTIVE' } } }))
  .waitForAssertions(singleBuildPoll);

// 11. Occupancy guard: deleting a cell that still holds a tenant → 409
//     (ADR-014). Then offboard tenant #1: the record disappears when the
//     tenant delete script has run and the terminal transaction freed the
//     slot — the CELL slot, not the account's: cell 1 stays (explicit
//     scale-in, ADR-014) and A stays 2/2.
const deleteCellOccupied = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId1}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 409 }));

const deleteTenant1 = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 202, body: { tenant: { status: 'DELETING' } } }));

const waitForTenant1Gone = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 404 }))
  .waitForAssertions(singleBuildPoll);

const getCell1SlotFreed = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId1}`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: { cell: { status: 'ACTIVE', tenantCount: 0, maxTenants: 1 } },
    }),
  );

const getAccountAStillFull = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountA}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { account: { cellCount: 2, maxCells: 2 } } }));

const checkTenantParam1Gone = integ.assertions
  .awsApiCall('SSM', 'getParameters', {
    Names: [`/application-plane/tenants/${tenantId1}`],
  })
  .expect(
    ExpectedResult.objectLike({
      Parameters: [],
      InvalidParameters: [`/application-plane/tenants/${tenantId1}`],
    }),
  );
checkTenantParam1Gone.provider.addToRolePolicy(ssmReadPolicy);

// Reuse before create (§7 steps 1–2): an untargeted onboard now finds the
// empty cell 1 and places into it — no new cell, no 409, one build only.
const createTenant5 = integ.assertions.httpApiCall(`${apiUrl}tenants`, {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({
    name: 'integ-tenant-5',
    adminEmail: 'success+integ-tenant-5@simulator.amazonses.com',
  }),
});
const tenantId5 = createTenant5.getAttString('body.tenant.tenantId');

const waitForActive5 = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId5}`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: { tenant: { status: 'ACTIVE', cellId: cellId1 } },
    }),
  )
  .waitForAssertions(singleBuildPoll);

// 12. Teardown. Offboard tenants #5, #2, #3 …
const deleteTenant5 = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId5}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 202, body: { tenant: { status: 'DELETING' } } }));
const waitForTenant5Gone = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId5}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 404 }))
  .waitForAssertions(singleBuildPoll);

const deleteTenant2 = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 202, body: { tenant: { status: 'DELETING' } } }));
const waitForTenant2Gone = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 404 }))
  .waitForAssertions(singleBuildPoll);

const deleteTenant3 = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId3}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 202, body: { tenant: { status: 'DELETING' } } }));
const waitForTenant3Gone = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId3}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 404 }))
  .waitForAssertions(singleBuildPoll);

// … no per-tenant deployments remain, in either account …
const checkTenantNamespaceEmptyA = integ.assertions
  .awsApiCall('SSM', 'getParametersByPath', {
    Path: '/application-plane/tenants',
    Recursive: true,
  })
  .expect(ExpectedResult.objectLike({ Parameters: [] }));
checkTenantNamespaceEmptyA.provider.addToRolePolicy(ssmReadPolicy);

const probeTenantNamespaceEmptyB = probeB('ProbeTenantsEmptyB', { path: '/application-plane/tenants' })
  .expect(ExpectedResult.objectLike({ Payload: '0' }));

// … deprovision the three (now empty) cells; each record disappears when
// the cell delete script has run and the terminal transaction released the
// account's cell slot (ADR-024) …
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

// … both accounts are empty again, the fleet has no cells, and the cell
// delete scripts cleaned their namespaces in both accounts …
const getAccountAEmpty = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountA}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { account: { cellCount: 0, maxCells: 2 } } }));
const getAccountBEmpty = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountB}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { account: { cellCount: 0, maxCells: 1 } } }));

const listCellsEmpty = integ.assertions
  .httpApiCall(`${apiUrl}cells`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { cells: [] } }));

const checkCellNamespacesEmptyA = integ.assertions
  .awsApiCall('SSM', 'getParametersByPath', {
    Path: '/application-plane/cells',
    Recursive: true,
  })
  .expect(ExpectedResult.objectLike({ Parameters: [] }));
checkCellNamespacesEmptyA.provider.addToRolePolicy(ssmReadPolicy);

const probeCellNamespacesEmptyB = probeB('ProbeCellsEmptyB', { path: '/application-plane/cells' })
  .expect(ExpectedResult.objectLike({ Payload: '0' }));

// … and the accounts can be deregistered (empty-only, ADR-024).
const deleteAccountA = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountA}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { account: { accountId: accountA } } }));
const deleteAccountB = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountB}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { account: { accountId: accountB } } }));

const listAccountsEmpty = integ.assertions
  .httpApiCall(`${apiUrl}accounts`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { accounts: [] } }));

// Sequence the lifecycle strictly (references alone order most of it, but
// the reads/guards must not race the polls, and the in-flight 409 must fire
// while tenant #3 is still CREATING).
createUser
  .next(randomPassword)
  .next(setPassword)
  .next(authenticate)
  // accounts
  .next(putUnregisteredAccount)
  .next(putAccountANotEnforcingExternalId)
  .next(putAccountA)
  .next(putAccountBNoExternalId)
  .next(putAccountBWrongExternalId)
  .next(putAccountB)
  .next(listAccountsTwo)
  // onboard #1 → cell 1 in A (+ clientToken replay + mismatch 409, ADR-017)
  .next(createTenant1)
  .next(waitForActive1)
  .next(listCellsOne)
  .next(getCell1)
  .next(getAccountAOne)
  .next(checkCellParam)
  .next(checkTenantParam1)
  .next(replayCreateTenant1)
  .next(reuseTokenMismatch)
  .next(listCellsStillOne)
  // onboard #2 → cell 2 in A; A full
  .next(createTenant2)
  .next(waitForActive2)
  .next(getAccountAFull)
  .next(listCellsTwo)
  // untargeted onboard with only tenant-owned capacity left → 409
  .next(createTenant3Untargeted)
  .next(listCellsStillTwo)
  // onboard #3 → cell 3 in B (+ in-flight guard)
  .next(createTenant3)
  .next(deleteWhileCreating)
  .next(waitForActive3)
  .next(getCell3)
  .next(probeCell3InB)
  .next(probeTenant3InB)
  .next(checkCell3NotInA)
  .next(getAccountBFull)
  // B full: targeted 409, occupied-account 409, owner-change 409
  .next(createTenant4AtFullB)
  .next(deleteAccountBOccupied)
  .next(putAccountBOwnerChange)
  // reads
  .next(listCellsThree)
  .next(listCellsInA)
  .next(listCellsUnknownAccount)
  .next(getResource1)
  .next(listTenantsByCell1)
  .next(listTenantsUnknownCell)
  .next(updateTenant1)
  .next(getTenant1Updated)
  // re-apply in A and in B
  .next(updateResource1)
  .next(waitForTenant1Updated)
  .next(updateCell3)
  .next(waitForCell3Updated)
  // guards, offboard #1, reuse cell 1 for #5
  .next(deleteCellOccupied)
  .next(deleteTenant1)
  .next(waitForTenant1Gone)
  .next(getCell1SlotFreed)
  .next(getAccountAStillFull)
  .next(checkTenantParam1Gone)
  .next(createTenant5)
  .next(waitForActive5)
  // teardown
  .next(deleteTenant5)
  .next(waitForTenant5Gone)
  .next(deleteTenant2)
  .next(waitForTenant2Gone)
  .next(deleteTenant3)
  .next(waitForTenant3Gone)
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
  .next(listCellsEmpty)
  .next(checkCellNamespacesEmptyA)
  .next(probeCellNamespacesEmptyB)
  .next(deleteAccountA)
  .next(deleteAccountB)
  .next(listAccountsEmpty);

/** Reads a required environment variable or fails synth with the reason it is needed. */
function requireEnv(name: string, purpose: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} must be set: ${purpose}`);
  }
  return value;
}
