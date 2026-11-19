// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as path from 'path';
import { ExpectedResult, IApiCall, IntegTest, Match } from '@aws-cdk/integ-tests-alpha';
import { App, Aspects, ArnFormat, Aws, CfnOutput, CfnResource, Duration, IAspect, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { ApplicationLogLevel } from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { RegionInfo } from 'aws-cdk-lib/region-info';
import { WriteNagSuppressionsToCloudFormationAspect } from 'cdk-nag';
import { IConstruct } from 'constructs';
import { CellAccountStack } from '../src/cell-account/cell-account.cdk';
import { provisioningRoleName } from '../src/shared/fleet';
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
 * Each run takes its own fleet name, `cp-integ-<run id>` (spec section 10),
 * from `CP_INTEG_RUN_ID` (`[a-z0-9]{1,23}`, the `integ` task generates one),
 * and uses it in every stack name, as the `fleetName` of the stack under test
 * and of the account B role pair, and in every other name that must be unique
 * in an account or a Region. The application ids derive from the run id
 * (`x-<run id>`, `y-<run id>`, `z-<run id>`). Two runs can then share both
 * accounts and a Region.
 *
 * Setup (in A): a throwaway Cognito user pool acts as the vendor IdP (its ID
 * tokens carry iss + aud, which the authorizer validates via OIDC discovery,
 * plus the `role: "operator"` claim ADR-018 requires, added by a pre token
 * generation trigger); the sample cell + tenant scripts are hosted in an S3
 * bucket used as the applications' CodeBuild ProjectSource; and a probe
 * Lambda that assumes a read-only role in B to count SSM parameters (and list the cell role's managed policies) there
 * (the assertion provider itself runs in A only); and a build probe that
 * reads the PARAM_ variables of a CodeBuild project's latest build, which
 * is what the script of that build received; and a step probe that runs a
 * list of checks in one invocation (API calls, SSM reads, and what the test's
 * hooks recorded, in SSM parameters under a test-only path that each hook
 * role may write through one customer-managed policy per hook role, together
 * with the start time of every script build, so the test can assert the order
 * hooks and scripts ran in). The assertion stack is a CloudFormation stack
 * that holds 200 outputs at most and every assertion is one, so checks that
 * need no waiting between them are one probe invocation. Applications X and Y share
 * that source and differ in id and in their parameter declarations (X
 * declares ALLOWED_EMAIL_DOMAIN, required, and LOG_LEVEL, default info, and
 * the cell parameter CELL_SIZE, default small; Y declares none);
 * maxTenants = 1: every cell is a silo, so cells — not deployments — are
 * what the accounts count.
 *
 * Application Z (step 16) uses Y's source and scripts, except that its tenant
 * create script writes a script output first; it declares three parameters
 * and two application hooks, and two global hooks are registered around it.
 *
 * Flow (every API operation is exercised; the numbers are spec §10's steps,
 * with the operator minted in step 1):
 *   1. unauthenticated request → 401; mint an operator: adminCreateUser →
 *      adminSetUserPassword → adminInitiateAuth → ID token; mint a reader
 *      (role control-plane:reader) and a user whose role is in neither list
 *      the same way (R-36); after step 4's tenants exist, the reader's first
 *      call is a POST (403), then its GETs pass and its PUT and DELETE are
 *      403, the unlisted role is 403 on a GET and a POST, and nothing was
 *      written; once step 5's deployment and cell exist, the reader's other
 *      seven GETs pass too, and once step 16 has registered a hook, GetHook and
 *      ListHooks pass, so all twelve reader operations are proven; a listed
 *      machine client's
 *      client-credentials token (no `aud`, R-38) reads and is 403 on a POST,
 *      and an unlisted machine client is 403 on a GET
 *   The seven record operations (PutApplication, DeleteApplication,
 *   CreateTenant, UpdateTenant, DeleteTenant, PutAccount, DeleteAccount)
 *   answer 202 (ADR-045): each accepted one is polled with its Get operation
 *   to ACTIVE (a delete to 404) before a later call uses the record.
 *   2. PutApplication with a missing script → 400, bad id → 400, bad
 *      parameter declarations → 400; X (with declarations) and Y → 202
 *      CREATING → ACTIVE; ListApplications; PutAccount naming an unknown
 *      application → 404
 *   3. PutAccount handshake refusals (no pair, pair not enforcing the id, no
 *      external id, wrong external id) and 101 applicationIds → 400;
 *      PutAccount A (VENDOR, 2, shared) and B (TENANT, 1, external id, Y
 *      only) → 202 → ACTIVE; ListAccounts
 *   4. CreateTenant T1, T2, T3 → 202 → ACTIVE, no cell; UpdateTenant T3 →
 *      202 → ACTIVE; DeleteTenant T3 → 202 → 404; CreateDeployment for T3
 *      or an unknown application → 404
 *   5. CreateDeployment T1/X without the required parameter or with an
 *      undeclared one → 400; with ALLOWED_EMAIL_DOMAIN (clientToken) → cell
 *      1 in A → poll ACTIVE; GetDeployment resolves the stamp and returns
 *      the stored values; A 1/2, X 1, T1 1; parameters in A; the tenant
 *      build got the value and the LOG_LEVEL default, the cell build the
 *      CELL_SIZE default
 *   6. CreateDeployment T1/Y → cell 2 in A; A 2/2, Y 1, T1 2; filters;
 *      each cell read ITS application's shared namespace; T1/X again → 409;
 *      DeleteTenant T1 → 409 (occupied)
 *   7. replay T1/X with the same token → the same deployment (ADR-017);
 *      the token with another application or another parameter value → 409
 *   8. CreateDeployment T2/X untargeted → 409 InsufficientCapacity (A full,
 *      B tenant-owned)
 *   9. T2/X at B → 400 (B admits Y only, ADR-033)
 *  10. CreateDeployment T2/Y at B → cell 3 in B; in-flight delete → 409;
 *      parameters in B and not in A; B 1/1, Y 2
 *  11. T4/Y at B → 409 (full); DeleteAccount B, DeleteApplication Y → 409;
 *      owner change → 409; DeleteTenant T4 → 202 → 404
 *  12. reads: ListCells with filters, two filters → 400; ListDeployments
 *      with filters; UpdateTenant; PutApplication Y replaced, cells 2 and 3
 *      keep their stamp (P-4)
 *  13. UpdateDeployment T1/X (in A) and UpdateCell cell 3 (in B) → ACTIVE;
 *      T1/X merges LOG_LEVEL; removing a required parameter, one name in
 *      both lists, a cell parameter name or a control character → 400;
 *      UpdateCell cell 1 sets and removes CELL_SIZE; a tenant parameter or
 *      an undeclared name on UpdateCell → 400
 *  14. PutApplication X without lists keeps them; new defaults reach T1/X
 *      and cell 1; a newly required TIER makes UpdateDeployment T1/X a 400
 *  15. DeleteCell occupied → 409; DeleteDeployment T1/X → 404 (it ran
 *      without TIER, with the stale value and the default); cell 1 stays
 *      0/1, A 2/2, X 1, T1 1; CreateDeployment T2/X reuses cell 1
 *  16. hooks (ADR-044): ListHooks empty; PutHook refusals → 400, a reader's
 *      PutHook → 403; PutHook G (POST, all six events) → revision 1, again →
 *      revision 2; the counter's limit of five → 409 on the sixth; Z (three
 *      parameters, two application hooks) in cell 4 of A (maxCells 3): the
 *      scripts and hooks of T1/Z's create ran in R-45 order, with the R-42
 *      variables, the script output as SCRIPT_OUTPUTS, each hook under its
 *      own role and the R-41 deny holding; lastGlobalHooks on the cell and the
 *      deployment; an update; a failing global PRE hook ends T2/Z
 *      CREATE_FAILED before its script; a failing delete hook is attempted
 *      three times and skipped; a failing POST hook ends a create
 *      CREATE_FAILED after its script; each delete runs its hooks around its
 *      script
 *  17. hooks on record events (ADR-045): an application hook on a TENANT_*
 *      or ACCOUNT_* event → 400; global R (PRE, TENANT_CREATE and
 *      TENANT_UPDATE) refuses the tenant name `blocked`: that tenant ends
 *      CREATE_FAILED, a deployment for it → 409 without a retry hint, it is
 *      deleted; T5 → ACTIVE, renamed `blocked` → UPDATE_FAILED with its old
 *      name live, renamed again → ACTIVE, deleted; R saw the R-42 tenant
 *      variables and nothing of a cell or an application; Z gains c-post
 *      (POST, APPLICATION_UPDATE): UPDATING, a second put → 409, ACTIVE,
 *      c-post saw SCRIPT_OUTPUTS {} and no cell; cell 4 keeps its stamp;
 *      global N (POST, ACCOUNT_CREATE) is registered for step 18
 *  18. delete every deployment, cell (cell 4 included), hook, tenant,
 *      account and application; every counter back at 0; this run's
 *      namespaces empty in both accounts; the delete builds got the values §10
 *      names; G recorded a CELL_DELETE for every cell; B is registered again
 *      and N recorded its ACCOUNT_CREATE without the external id
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
/**
 * This run's id and fleet name (spec section 10). The `integ` task sets
 * CP_INTEG_RUN_ID; it must not contain `aws`, `amazon` or `cognito`, so the
 * user pool domain prefix built from the fleet name holds none of the words
 * Cognito refuses.
 */
const runId = requireEnv('CP_INTEG_RUN_ID', 'this run\'s id, 1 to 23 characters of [a-z0-9] without aws, amazon or cognito (the integ task generates one)');
if (!/^[a-z0-9]{1,23}$/.test(runId) || /aws|amazon|cognito/.test(runId)) {
  throw new Error('CP_INTEG_RUN_ID must match [a-z0-9]{1,23} and must not contain aws, amazon or cognito');
}
const fleetName = `cp-integ-${runId}`;
/** No account has the pair installed under this id: the handshake must refuse it. */
const unregisteredAccount = '000000000000';
/** The external id account B's role pair requires (spec §6.4) — a handshake value, not a secret. */
const accountBExternalId = 'control-plane-integ-handshake';
/** The applications (spec §10): same scripts, ids from the run id. B admits Y only. Z is step 16's. */
const APP_X = `x-${runId}`;
const APP_Y = `y-${runId}`;
const APP_Z = `z-${runId}`;
const partition = RegionInfo.get(region).partition ?? 'aws';
/** Where the test's hooks record what they saw, in A (one path per hook scope). */
const hookLedgerRoot = `/cp-integ/${fleetName}/hooks`;
const hookPolicyName = (scope: 'global' | 'app') => `${fleetName}-${scope}-hook-test`;
/** ADR-0047: the test policy B's owner attaches to B's cell provisioning role, named per run (`<fleet>-cell-extra`). */
const cellExtraPolicyName = `${fleetName}-cell-extra`;
const cellExtraPolicyArn = `arn:${partition}:iam::${accountB}:policy/${cellExtraPolicyName}`;
/** ADR-0046: the stack under test raises the build cap above the default 5 (and the warning threshold). */
const INTEG_CONCURRENT_BUILD_LIMIT = 50;

const app = new App();

// --- Setup stack (account A): vendor IdP + script source + probe ----------
// Every stack of account A names its environment, as the account B stack
// does: the stack under test must (it validates its hook policy ARNs against
// its own partition and account at synth), and CDK refuses a reference between
// a stack with an environment and one without.
const setup = new Stack(app, `${fleetName}-setup`, { env: { account: accountA, region } });

const vendorIdp = new cognito.UserPool(setup, 'VendorIdp', {
  selfSignUpEnabled: false,
  removalPolicy: RemovalPolicy.DESTROY,
  // R-38: a V3 trigger is the only way to add `role` to a client-credentials
  // access token, and it needs the Essentials (or Plus) feature plan.
  featurePlan: cognito.FeaturePlan.ESSENTIALS,
});
// ADR-018 deployment contract: the vendor IdP must mint `role: "operator"`
// on operator tokens - the authorizer fails closed on a missing role. A
// plain Cognito token carries no such claim, so this pre token generation
// trigger (V3_0 event) adds it, exactly as a real vendor IdP would be
// configured to. Two more test users get other roles (R-36): the reader
// value the stack lists in readerRoles, and a value in neither list. Users'
// roles go on the ID token. A client-credentials token (R-38) names no user,
// so the trigger branches on triggerSource and puts the reader value on the
// access token of both machine clients; only the listed one may pass.
const mintOperatorRole = new lambda.Function(setup, 'MintOperatorRole', {
  runtime: lambda.Runtime.NODEJS_24_X,
  handler: 'index.handler',
  code: lambda.Code.fromInline(`
    exports.handler = async (event) => {
      if (event.triggerSource === 'TokenGeneration_ClientCredentials') {
        event.response = {
          claimsAndScopeOverrideDetails: {
            accessTokenGeneration: { claimsToAddOrOverride: { role: 'control-plane:reader' } },
          },
        };
        return event;
      }
      const role = event.userName.includes('integ-reader') ? 'control-plane:reader'
        : event.userName.includes('integ-norole') ? 'integ-unlisted'
        : 'operator';
      event.response = {
        claimsAndScopeOverrideDetails: {
          idTokenGeneration: { claimsToAddOrOverride: { role } },
        },
      };
      return event;
    };
  `),
});
vendorIdp.addTrigger(cognito.UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG, mintOperatorRole, cognito.LambdaVersion.V3_0);
// Test-only: the ID tokens are minted once, at the start of the assertions,
// and the run with hooks lasts about two hours, past Cognito's 1-hour
// default; the teardown then got 403. Four hours covers the run.
const idpClient = vendorIdp.addClient('IntegOperatorClient', {
  authFlows: { adminUserPassword: true },
  generateSecret: false,
  idTokenValidity: Duration.hours(4),
  accessTokenValidity: Duration.hours(4),
});

// R-38: two machine clients on the client credentials flow. Cognito runs
// that flow only at the domain's /oauth2/token endpoint and refuses a
// client-credentials client without a custom scope. The stack lists the
// first client in vendorIdpClientIds and requires `control-plane/read`; the
// second gets the same role and must still be refused. Both may also ask
// for `control-plane/other`, which stands in for another API's scope.
const idpDomain = vendorIdp.addDomain('VendorIdpDomain', {
  // A domain prefix is unique per Region across accounts: the fleet name
  // separates runs, the account id separates accounts.
  cognitoDomain: { domainPrefix: `${fleetName}-${accountA}` },
});
const readScope = new cognito.ResourceServerScope({ scopeName: 'read', scopeDescription: 'Integ test machine reads' });
const otherScope = new cognito.ResourceServerScope({ scopeName: 'other', scopeDescription: 'Integ test stand-in for another API' });
const controlPlaneResource = vendorIdp.addResourceServer('ControlPlaneResource', {
  identifier: 'control-plane',
  scopes: [readScope, otherScope],
});
const machineClientProps: cognito.UserPoolClientOptions = {
  generateSecret: true,
  authFlows: {},
  oAuth: {
    flows: { clientCredentials: true },
    scopes: [
      cognito.OAuthScope.resourceServer(controlPlaneResource, readScope),
      cognito.OAuthScope.resourceServer(controlPlaneResource, otherScope),
    ],
  },
};
const listedMachineClient = vendorIdp.addClient('IntegListedMachineClient', machineClientProps);
const unlistedMachineClient = vendorIdp.addClient('IntegUnlistedMachineClient', machineClientProps);

// Calls the API as a machine client: reads the client's secret, gets a
// client-credentials token for the event's scope (default
// `control-plane/read`) from the domain and makes one request. Returns
// the status and the facts R-38 depends on, never the secret or the token,
// so neither reaches a template, an output or the assertion results.
const machineProbe = new lambda.Function(setup, 'MachineClientProbe', {
  runtime: lambda.Runtime.NODEJS_24_X,
  handler: 'index.handler',
  timeout: Duration.seconds(30),
  environment: {
    USER_POOL_ID: vendorIdp.userPoolId,
    TOKEN_URL: `${idpDomain.baseUrl()}/oauth2/token`,
    DEFAULT_SCOPE: 'control-plane/read',
  },
  code: lambda.Code.fromInline(`
    const { CognitoIdentityProviderClient, DescribeUserPoolClientCommand } = require('@aws-sdk/client-cognito-identity-provider');
    exports.handler = async (event) => {
      const idp = new CognitoIdentityProviderClient({});
      const { UserPoolClient: c } = await idp.send(new DescribeUserPoolClientCommand({
        UserPoolId: process.env.USER_POOL_ID, ClientId: event.clientId,
      }));
      const basic = Buffer.from(c.ClientId + ':' + c.ClientSecret).toString('base64');
      const got = await fetch(process.env.TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + basic },
        body: 'grant_type=client_credentials&scope=' + encodeURIComponent(event.scope || process.env.DEFAULT_SCOPE),
        signal: AbortSignal.timeout(10000),
      });
      if (!got.ok) throw new Error('token endpoint returned ' + got.status);
      const token = (await got.json()).access_token;
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      const res = await fetch(event.url, {
        method: event.method,
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: event.body,
        signal: AbortSignal.timeout(10000),
      });
      return {
        status: res.status,
        hasAud: claims.aud !== undefined,
        subIsClient: claims.sub === claims.client_id,
        role: claims.role === undefined ? null : claims.role,
        scope: claims.scope === undefined ? null : claims.scope,
      };
    };
  `),
});
machineProbe.addToRolePolicy(new iam.PolicyStatement({
  actions: ['cognito-idp:DescribeUserPoolClient'],
  resources: [vendorIdp.userPoolArn],
}));

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

// Hook scripts and Z's tenant create script (test-only, test/integ-scripts).
// The hook script reads the fleet name from a file shipped beside it, because
// the control plane hands a hook no such value (R-42).
new s3deploy.BucketDeployment(setup, 'DeployHookScripts', {
  destinationBucket: scriptsBucket,
  destinationKeyPrefix: 'scripts/integ-hook',
  sources: [
    s3deploy.Source.asset(path.join(__dirname, 'integ-scripts/hook')),
    s3deploy.Source.data('fleet-name.txt', fleetName),
    // Lets the hook report whether any variable it received held account B's external id (step 18).
    s3deploy.Source.data('external-id.txt', accountBExternalId),
  ],
});
new s3deploy.BucketDeployment(setup, 'DeployZTenantScripts', {
  destinationBucket: scriptsBucket,
  destinationKeyPrefix: 'scripts/integ-z',
  sources: [s3deploy.Source.asset(path.join(__dirname, 'integ-scripts/z-tenant'))],
});

// The assertion provider runs in account A. To check what the scripts did
// in account B, this probe assumes a read-only role there (installed by the
// account B stack below, trusted by this function's role) and counts SSM
// parameters: by path (recursive) and/or by exact names. Returns the count.
const probeRoleName = `${fleetName}-probe`;
const probeRoleArn = `arn:${setup.partition}:iam::${accountB}:role/${probeRoleName}`;
// The probe function's role has a physical name so account B's probe role can
// trust it by an exact ARN: a generated name is cut at 64 characters, which a
// fleet name of 32 characters and the stack name's other parts would exceed.
const ssmProbeRoleName = `${fleetName}-ssm-probe`;
const ssmProbeRole = new iam.Role(setup, 'SsmProbeRole', {
  roleName: ssmProbeRoleName,
  assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
  managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
});
const ssmProbe = new lambda.Function(setup, 'SsmProbe', {
  runtime: lambda.Runtime.NODEJS_24_X,
  handler: 'index.handler',
  role: ssmProbeRole,
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
      if (event.attachedPoliciesOf) {
        // ADR-0047: the managed policies on a role in B, as sorted ARNs.
        const { IAMClient, ListAttachedRolePoliciesCommand } = require('@aws-sdk/client-iam');
        const iam = new IAMClient({
          region: event.region,
          credentials: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken },
        });
        const got = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: event.attachedPoliciesOf }));
        return (got.AttachedPolicies || []).map((p) => p.PolicyArn).sort().join(',');
      }
      let count = 0;
      for (const path of [event.path, ...(event.paths || [])].filter(Boolean)) {
        let token;
        do {
          const page = await ssm.send(new GetParametersByPathCommand({ Path: path, Recursive: true, NextToken: token }));
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

// The scripts' PARAM_ variables are checked at the source: this probe reads
// the latest build of a CodeBuild project (the projects live in A whichever
// account a build provisions in) and returns its PARAM_ variables as a
// name-sorted object. A build's environment is what its script receives,
// and it outlives the namespaces the delete scripts empty (spec §10 steps
// 13-16). The test runs one build at a time, so the latest build is the one
// the preceding step started. `check` only makes each call distinct.
const buildProbe = new lambda.Function(setup, 'BuildParameterProbe', {
  runtime: lambda.Runtime.NODEJS_24_X,
  handler: 'index.handler',
  timeout: Duration.seconds(30),
  code: lambda.Code.fromInline(`
    const { CodeBuildClient, ListBuildsForProjectCommand, BatchGetBuildsCommand } = require('@aws-sdk/client-codebuild');
    exports.handler = async (event) => {
      const codebuild = new CodeBuildClient({});
      const listed = await codebuild.send(new ListBuildsForProjectCommand({ projectName: event.projectName, sortOrder: 'DESCENDING' }));
      const id = (listed.ids || [])[0];
      if (!id) {
        throw new Error('No build of ' + event.projectName);
      }
      const got = await codebuild.send(new BatchGetBuildsCommand({ ids: [id] }));
      const variables = ((got.builds || [])[0]?.environment?.environmentVariables || [])
        .filter((v) => v.name.startsWith('PARAM_'))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return Object.fromEntries(variables.map((v) => [v.name, v.value]));
    };
  `),
});
buildProbe.addToRolePolicy(new iam.PolicyStatement({
  actions: ['codebuild:ListBuildsForProject', 'codebuild:BatchGetBuilds'],
  // The projects belong to the stack under test, which deploys after this
  // one; any project in this account and Region, for a test-only probe.
  resources: [setup.formatArn({ service: 'codebuild', resource: 'project', resourceName: '*' })],
}));

// The step probe: runs a list of checks (API calls, SSM reads, and what the
// test's hooks recorded together with when each script ran) in one invocation
// and returns "ok" or what failed. An assertion stack holds 200 outputs at
// most and every assertion is one, so the checks between two waits are one
// invocation. The code is a plain JavaScript asset (an inline function may not
// be this long); the Lambda runtime provides the SDK clients it uses.
const ssmParameterArn = (parameterPath: string) =>
  setup.formatArn({ service: 'ssm', resource: 'parameter', resourceName: parameterPath, arnFormat: ArnFormat.SLASH_RESOURCE_NAME });
const stepProbe = new lambda.Function(setup, 'StepProbe', {
  runtime: lambda.Runtime.NODEJS_24_X,
  handler: 'index.handler',
  timeout: Duration.minutes(5),
  code: lambda.Code.fromAsset(path.join(__dirname, 'integ-scripts/probe')),
});
stepProbe.addToRolePolicy(new iam.PolicyStatement({
  actions: ['ssm:GetParametersByPath', 'ssm:DeleteParameters'],
  resources: [ssmParameterArn(`cp-integ/${fleetName}`), ssmParameterArn(`cp-integ/${fleetName}/*`)],
}));
stepProbe.addToRolePolicy(new iam.PolicyStatement({
  actions: ['ssm:GetParameters', 'ssm:GetParametersByPath'],
  resources: [ssmParameterArn('application-plane'), ssmParameterArn('application-plane/*')],
}));
stepProbe.addToRolePolicy(new iam.PolicyStatement({
  actions: ['codebuild:ListBuildsForProject', 'codebuild:BatchGetBuilds'],
  resources: [setup.formatArn({ service: 'codebuild', resource: 'project', resourceName: `${fleetName}-*` })],
}));

// The two customer-managed policies the stack attaches to its hook roles
// (R-41, globalHookManagedPolicyArns and appHookManagedPolicyArns). Each lets
// its hook role write SSM parameters under its own test path in A and nowhere
// else. The application hook policy also allows what the R-41 deny must
// override: StartExecution on the workflow, named by its computed ARN, and
// Invoke on every function of the account (the API function's name is
// generated; a request with a qualifier matches the same wildcard). The
// policies exist before the stack because it validates the ARNs at synth.
const hookPolicyArn = (scope: 'global' | 'app') => `arn:${partition}:iam::${accountA}:policy/${hookPolicyName(scope)}`;
new iam.ManagedPolicy(setup, 'GlobalHookTestPolicy', {
  managedPolicyName: hookPolicyName('global'),
  description: 'control-plane integ test only: the global hook role may record under its own test path',
  statements: [
    new iam.PolicyStatement({ actions: ['ssm:PutParameter'], resources: [ssmParameterArn(`${hookLedgerRoot.slice(1)}/global/*`)] }),
  ],
});
new iam.ManagedPolicy(setup, 'AppHookTestPolicy', {
  managedPolicyName: hookPolicyName('app'),
  description: 'control-plane integ test only: the application hook role may record under its own test path, and holds two grants the R-41 deny must override',
  statements: [
    new iam.PolicyStatement({ actions: ['ssm:PutParameter'], resources: [ssmParameterArn(`${hookLedgerRoot.slice(1)}/app/*`)] }),
    new iam.PolicyStatement({
      actions: ['states:StartExecution'],
      resources: [`arn:${partition}:states:${region}:${accountA}:stateMachine:${fleetName}-workflow`],
    }),
    // Step 16 needs this allow on the API function only, so the R-41 deny is
    // shown to override it. It stays a pattern, and the ProtoShield
    // iam-least-privilege finding on `function:*` (scan cp-0045-1) is
    // accepted for this test-only policy: the policy must exist before the
    // stack under test (the stack validates appHookManagedPolicyArns at
    // synth and attaches the policy at deploy), and the API function has no
    // physical name. CloudFormation generates it from the stack name, the
    // logical id and a random suffix, truncated to 64 characters by a rule
    // it does not document, so not even a `function:<fleet>-*` prefix is
    // certain to match. The policy exists only for the run and goes with the
    // setup stack.
    new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:${partition}:lambda:${region}:${accountA}:function:*`],
    }),
  ],
});

// --- Account B stack: the role pair a customer installs + the test probe role
// Deployed into B with A's credentials (B is bootstrapped to trust A). The
// pair trusts A's build roles by ARN with the external id; nothing in A has
// to exist first (the trust is account + aws:PrincipalArn, ADR-025).
const accountBStack = new CellAccountStack(app, `${fleetName}-account-b`, {
  controlPlaneAccountId: accountA,
  fleetName,
  externalId: accountBExternalId,
  // The sample cell script reads its application's demo shared parameter
  // (ADR-034); B hosts cells of Y only.
  demoApplicationIds: [APP_Y],
  // ADR-0047: B's owner attaches one policy to its cell provisioning role.
  cellBuildManagedPolicyArns: [cellExtraPolicyArn],
  env: { account: accountB, region },
});
// The attached policy lives in B's own stack. The role names it by ARN, so
// the policy is created first. It grants one read the sample scripts never
// make, so it widens nothing the test depends on.
const cellExtraPolicy = new iam.ManagedPolicy(accountBStack, 'IntegCellExtraPolicy', {
  managedPolicyName: cellExtraPolicyName,
  description: 'control-plane integ test only: proves cellBuildManagedPolicyArns attaches to the cell provisioning role (ADR-0047)',
  statements: [new iam.PolicyStatement({
    actions: ['ssm:GetParameter'],
    resources: [accountBStack.formatArn({ service: 'ssm', resource: 'parameter', resourceName: `${fleetName}/cell-extra` })],
  })],
});
accountBStack.roles.cellRole.node.addDependency(cellExtraPolicy);
const probeRole = new iam.Role(accountBStack, 'IntegProbeRole', {
  roleName: probeRoleName,
  description: 'control-plane integ test only: lets the probe Lambda in the control plane account count SSM parameters here',
  assumedBy: new iam.PrincipalWithConditions(new iam.AccountPrincipal(accountA), {
    ArnEquals: { 'aws:PrincipalArn': `arn:${accountBStack.partition}:iam::${accountA}:role/${ssmProbeRoleName}` },
  }),
});
probeRole.addToPolicy(new iam.PolicyStatement({
  actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
  resources: [accountBStack.formatArn({ service: 'ssm', resource: 'parameter', resourceName: 'application-plane/*' })],
}));
// ADR-0047: step 1 reads which managed policies B's cell role carries.
probeRole.addToPolicy(new iam.PolicyStatement({
  actions: ['iam:ListAttachedRolePolicies'],
  resources: [accountBStack.roles.cellRole.roleArn],
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
// X declares parameters (spec §10 step 2); Y is registered with the plain
// definition and declares none.
const declarationsX = {
  parameters: [
    { name: 'ALLOWED_EMAIL_DOMAIN', required: true, description: 'Domain the first admin may sign in from' },
    { name: 'LOG_LEVEL', default: 'info' },
  ],
  cellParameters: [{ name: 'CELL_SIZE', default: 'small' }],
};
const definitionX = { ...definition, ...declarationsX };
/** The values every CreateDeployment of X supplies until step 14 says otherwise. */
const parametersX = { ALLOWED_EMAIL_DOMAIN: 'example.com' };

const stack = new TenantStack(app, fleetName, {
  env: { account: accountA, region },
  fleetName,
  vendorIdpIssuerUrl: vendorIdp.userPoolProviderUrl,
  vendorIdpAudience: idpClient.userPoolClientId,
  // The sample cell script reads each application's shared parameter in the
  // account it runs in (ADR-034); A hosts cells of both applications.
  demoApplicationIds: [APP_X, APP_Y, APP_Z],
  // R-41: one test policy per hook role (above).
  globalHookManagedPolicyArns: [hookPolicyArn('global')],
  appHookManagedPolicyArns: [hookPolicyArn('app')],
  // R-36: the reader user's role gets the GET-only grant (step 1).
  readerRoles: ['control-plane:reader'],
  // R-38: the listed machine client's token has no `aud` (step 1).
  vendorIdpClientIds: [listedMachineClient.userPoolClientId],
  vendorIdpRequiredScope: 'control-plane/read',
  // ADR-0046: every project takes the deployer's cap (step 1 reads it back).
  concurrentBuildLimit: INTEG_CONCURRENT_BUILD_LIMIT,
});
// Both shared CodeBuild projects pull the stamped source from the test
// bucket (the source fetch runs under the build role, before the buildspec
// assumes the account's provisioning role).
scriptsBucket.grantRead(stack.provisioning.cellProject);
scriptsBucket.grantRead(stack.provisioning.tenantProject);
// The hook projects fetch the hooks' source from the same bucket, under the
// hook roles (their source read is the deployer's grant, as for the
// provisioning projects).
scriptsBucket.grantRead(stack.provisioning.globalHookProject);
scriptsBucket.grantRead(stack.provisioning.appHookProject);
// Application Z's two parameters that name the stack's own resources: R-42
// hands a hook neither, so Z's defaults carry them (step 16).
const apiFunctionName = (stack.node.findChild('ApiFunctionName') as CfnOutput).value as string;
const stateMachineArn = (stack.node.findChild('StateMachineArn') as CfnOutput).value as string;

// --- Assertions --------------------------------------------------------------
// The assertion stack is ours, so that it names its environment like the
// other stacks of A and carries the fleet name.
const assertionStack = new Stack(app, `${fleetName}-assert`, { env: { account: accountA, region } });
const integ = new IntegTest(app, `ControlPlaneInteg${runId}`, {
  testCases: [setup, accountBStack, stack],
  assertionStack,
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
      case 'AWS::IAM::ManagedPolicy':
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

/**
 * The PARAM_ variables of the latest build of the cell or tenant project,
 * as the JSON object the probe returns (keys name-sorted).
 */
function expectBuildParameters(check: string, project: 'cell' | 'tenant', parameters: Record<string, string>) {
  const projectName = (project === 'cell' ? stack.provisioning.cellProject : stack.provisioning.tenantProject).projectName;
  const sorted = Object.fromEntries(Object.entries(parameters).sort(([a], [b]) => (a < b ? -1 : 1)));
  return integ.assertions
    .invokeFunction({ functionName: buildProbe.functionName, payload: JSON.stringify({ projectName, check }) })
    .expect(ExpectedResult.objectLike({ Payload: JSON.stringify(sorted) }));
}

/** Counts SSM parameters in account B through the probe (path and/or names). */
function probeB(id: string, query: { path?: string; paths?: string[]; names?: string[] }) {
  return integ.assertions.invokeFunction({
    functionName: ssmProbe.functionName,
    payload: JSON.stringify({ roleArn: probeRoleArn, region, ...query }),
  });
}

type ProbeStep = Record<string, unknown>;

/** A probe step that calls the API with the operator's, the reader's or the unlisted user's token. */
function api(
  name: string,
  method: string,
  apiPath: string,
  status: number,
  extra: { as?: 'operator' | 'reader' | 'unlisted'; body?: unknown; match?: unknown; errorType?: string } = {},
): ProbeStep {
  return {
    kind: 'http',
    name,
    method,
    url: `${apiUrl}${apiPath}`,
    as: extra.as ?? 'operator',
    status,
    body: extra.body === undefined ? undefined : JSON.stringify(extra.body),
    match: extra.match,
    errorType: extra.errorType,
  };
}

/** A probe step that compares what the hooks recorded and when the scripts ran (step 16) with `expect`. */
function ledger(name: string, check: string, expect: unknown, extra: Record<string, unknown> = {}): ProbeStep {
  return { kind: 'ledger', name, check, expect, ...extra };
}

// Record operations answer 202 (ADR-045). An event that runs no hook build
// ends in seconds, so its poll is a probe step: an assertion stack holds 200
// outputs at most and every waiter is one, and the scenario is near that.
// The probe asks every RECORD_POLL_INTERVAL_SECONDS, at most
// RECORD_POLL_SECONDS per step and 100 seconds per invocation, because the
// assertion provider that calls it times out after two minutes. An event that
// runs a hook build (steps 17 and 18) takes minutes, so its poll is a waiter
// at the cell and deployment interval instead (waitForRecord).
const RECORD_POLL_SECONDS = 60;
const RECORD_POLL_INTERVAL_SECONDS = 5;

/** A probe step that polls a record's Get operation until it answers `status` with `match` (ADR-045). */
function pollRecord(name: string, apiPath: string, status: number, match?: unknown): ProbeStep {
  return { ...api(name, 'GET', apiPath, status, { match }), pollSeconds: RECORD_POLL_SECONDS };
}
/** Polls an application, tenant or account (`key` names it in the body) to ACTIVE with `fields`. */
function pollActive(name: string, apiPath: string, key: 'application' | 'tenant' | 'account', fields: Record<string, unknown> = {}): ProbeStep {
  return pollRecord(name, apiPath, 200, { [key]: { status: 'ACTIVE', ...fields } });
}
/** Polls a deleted application, tenant or account until its Get operation answers 404. */
function pollGone(name: string, apiPath: string): ProbeStep {
  return pollRecord(name, apiPath, 404);
}
/**
 * Waits for a record whose event runs a hook build (steps 17 and 18): its Get
 * operation, polled at the cell and deployment interval within the
 * single-build budget, until the record matches `fields`.
 */
function waitForRecord(apiPath: string, key: 'application' | 'tenant' | 'account', fields: Record<string, unknown>) {
  return integ.assertions
    .httpApiCall(`${apiUrl}${apiPath}`, { method: 'GET', headers: authHeaders })
    .expect(ExpectedResult.objectLike({ status: 200, body: { [key]: fields } }))
    .waitForAssertions(singleBuildPoll);
}
/**
 * The check of a create whose new id the test reads (an HttpApiCall cannot
 * carry `.expect()` too): the record it returned is CREATING, which only the
 * asynchronous operation answers (ADR-045).
 */
function acceptedCreating(name: string, call: IApiCall, key: 'tenant'): ProbeStep {
  return { kind: 'value', name: `${name} CREATING`, actual: call.getAttString(`body.${key}.status`), expect: 'CREATING' };
}

/**
 * One probe invocation: the steps in order, expected to return "ok". `labelled`
 * lets the steps that read the ledger name tenants, cells and accounts by label
 * (A, T1, T2, cell1..cell4): pass it only once all of those ids exist.
 * `extraLabels` adds labels for ids that exist only from a later step on.
 */
function probeBatch(steps: ProbeStep[], labelled = false, extraLabels: [string, string][] = []) {
  const labels = labelled
    ? [[accountA, 'A'], [accountB, 'B'], [tenantId1, 'T1'], [tenantId2, 'T2'],
      [cellId1, 'cell1'], [cellId2, 'cell2'], [cellId3, 'cell3'], [cellId4, 'cell4'], ...extraLabels]
    : extraLabels;
  return integ.assertions
    .invokeFunction({
      functionName: stepProbe.functionName,
      payload: JSON.stringify({
        fleetName,
        cellProject: stack.provisioning.cellProject.projectName,
        tenantProject: stack.provisioning.tenantProject.projectName,
        labels,
        pollIntervalSeconds: RECORD_POLL_INTERVAL_SECONDS,
        headers: { operator: authHeaders, reader: readerHeaders, unlisted: unlistedIdentity.headers },
        steps,
      }),
    })
    .expect(ExpectedResult.objectLike({ Payload: '"ok"' }));
}

// 1. No vendor JWT → API Gateway rejects before any Lambda runs.
integ.assertions
  .httpApiCall(`${apiUrl}tenants`, { method: 'GET' })
  .expect(ExpectedResult.objectLike({ status: 401 }));

// 1 (deployment inputs). ADR-0046: all four projects, the two hook projects
// included, carry the deployer's cap.
integ.assertions
  // outputPaths keeps only the four limits: four whole project descriptions
  // exceed the 4 KB custom resource response ("Response object is too long").
  // A flattened response is checked path by path; `expect` sees no object.
  .awsApiCall('codebuild', 'batchGetProjects', {
    names: [
      stack.provisioning.cellProject.projectName,
      stack.provisioning.tenantProject.projectName,
      stack.provisioning.globalHookProject.projectName,
      stack.provisioning.appHookProject.projectName,
    ],
  }, [0, 1, 2, 3].map((i) => `projects.${i}.concurrentBuildLimit`))
  .assertAtPath('projects.0.concurrentBuildLimit', ExpectedResult.exact(INTEG_CONCURRENT_BUILD_LIMIT))
  .assertAtPath('projects.1.concurrentBuildLimit', ExpectedResult.exact(INTEG_CONCURRENT_BUILD_LIMIT))
  .assertAtPath('projects.2.concurrentBuildLimit', ExpectedResult.exact(INTEG_CONCURRENT_BUILD_LIMIT))
  .assertAtPath('projects.3.concurrentBuildLimit', ExpectedResult.exact(INTEG_CONCURRENT_BUILD_LIMIT));
// ADR-0047: B's cell role carries the owner's policy; B's tenant role is
// not asked, the unit tests pin that it gets none.
integ.assertions
  .invokeFunction({
    functionName: ssmProbe.functionName,
    payload: JSON.stringify({ roleArn: probeRoleArn, region, attachedPoliciesOf: provisioningRoleName(accountBStack.roles.fleetName, 'cell') }),
  })
  .expect(ExpectedResult.objectLike({ Payload: JSON.stringify(cellExtraPolicyArn) }));

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

// 1 (continued, R-36). Two more identities in the same pool: a reader and a
// role in neither list. Same throwaway password, own usernames.
function mintToken(username: string) {
  const create = integ.assertions.awsApiCall('cognito-identity-provider', 'adminCreateUser', {
    UserPoolId: vendorIdp.userPoolId,
    Username: username,
    MessageAction: 'SUPPRESS',
  });
  create.provider.addToRolePolicy(cognitoPolicy);
  const setPw = integ.assertions.awsApiCall('cognito-identity-provider', 'adminSetUserPassword', {
    UserPoolId: vendorIdp.userPoolId,
    Username: username,
    Password: password,
    Permanent: true,
  });
  setPw.provider.addToRolePolicy(cognitoPolicy);
  const auth = integ.assertions.awsApiCall(
    'cognito-identity-provider',
    'adminInitiateAuth',
    {
      UserPoolId: vendorIdp.userPoolId,
      ClientId: idpClient.userPoolClientId,
      AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: username, PASSWORD: password },
    },
    ['AuthenticationResult.IdToken'],
  );
  auth.provider.addToRolePolicy(cognitoPolicy);
  return {
    calls: [create, setPw, auth],
    headers: {
      'Authorization': `Bearer ${auth.getAttString('AuthenticationResult.IdToken')}`,
      'Content-Type': 'application/json',
    },
  };
}
const readerIdentity = mintToken('success+integ-reader@simulator.amazonses.com');
const unlistedIdentity = mintToken('success+integ-norole@simulator.amazonses.com');
const readerHeaders = readerIdentity.headers;

/** X's declarations as GetApplication returns them (spec §10 step 2). */
const declaredX = {
  parameters: [
    { name: 'ALLOWED_EMAIL_DOMAIN', required: true },
    { name: 'LOG_LEVEL', required: false, default: 'info' },
  ],
  cellParameters: [{ name: 'CELL_SIZE', default: 'small' }],
};

// 2. Applications (ADR-032). The generated validators reject an incomplete
//    definition and an id outside the charset before the handler runs.
// Parameter declarations are validated with the definition (§4.1): a
// lower-case name, a duplicate, a required parameter with a default, a cell
// parameter without one, and one name in both lists are each a 400. So are a
// missing script and an id outside the charset. Then X and Y are registered:
// PutApplication answers 202 with the record CREATING (ADR-045), and
// GetApplication polls each to ACTIVE. ListApplications sorts by id (the
// GSI-1 sort key; exact-length match). An allowlist may name registered
// applications only (ADR-033), checked before the handshake, so no AssumeRole
// is attempted. One probe batch.
const applications = probeBatch([
  api('PutApplication missing script', 'PUT', `applications/${APP_X}`, 400, {
    body: { ...definition, cellScripts: { create: definition.cellScripts.create, update: definition.cellScripts.update } },
  }),
  api('PutApplication bad id', 'PUT', 'applications/Integ_X', 400, { body: definition }),
  ...[
    { parameters: [{ name: 'log_level' }] },
    { parameters: [{ name: 'LOG_LEVEL' }, { name: 'LOG_LEVEL' }] },
    { parameters: [{ name: 'ALLOWED_EMAIL_DOMAIN', required: true, default: 'example.com' }] },
    { cellParameters: [{ name: 'CELL_SIZE' }] },
    { parameters: [{ name: 'CELL_SIZE' }], cellParameters: [{ name: 'CELL_SIZE', default: 'small' }] },
  ].map((lists, i) => api(`PutApplication bad declarations ${i + 1}`, 'PUT', `applications/${APP_X}`, 400, { body: { ...definition, ...lists } })),
  api('PutApplication X', 'PUT', `applications/${APP_X}`, 202, {
    body: definitionX,
    match: { application: { applicationId: APP_X, status: 'CREATING', maxTenants: 1, placementStrategy: 'FILL', cellCount: 0, ...declaredX } },
  }),
  api('PutApplication Y', 'PUT', `applications/${APP_Y}`, 202, {
    body: definition,
    match: { application: { applicationId: APP_Y, status: 'CREATING', cellCount: 0, parameters: [], cellParameters: [] } },
  }),
  pollActive('GetApplication X', `applications/${APP_X}`, 'application', { maxTenants: 1, cellCount: 0, ...declaredX }),
  pollActive('GetApplication Y', `applications/${APP_Y}`, 'application', { cellCount: 0 }),
  api('ListApplications two', 'GET', 'applications', 200, {
    match: { applications: [{ applicationId: APP_X, cellCount: 0 }, { applicationId: APP_Y, cellCount: 0 }] },
  }),
  api('PutAccount naming an unregistered application', 'PUT', `accounts/${accountA}`, 404, {
    body: { owner: 'VENDOR', maxCells: 2, applicationIds: ['integ-nope'] },
  }),
]);

// 3. Accounts (ADR-024, ADR-027, ADR-033), one probe batch. The handshake is
//    checked before any write: an account with no role pair is refused with
//    a 400 naming the role. A's pair was installed WITHOUT an external id, so
//    registering A with one (as if it were a customer's account) is refused
//    by the probe's negative call: the pair does not require the id it was
//    given (ADR-030); this comes before A's real registration so the refusal
//    is the handshake, not an owner change. More than 100 applicationIds is
//    a 400. A is the control plane's own account, vendor-owned, two cells,
//    shared (no applicationIds: it admits every application, ADR-033); the
//    stack installed its pair (R-25), no external id. A tenant-owned account
//    must carry an external id (ADR-029), and the wrong one is refused by B's
//    trust policy, the probe naming the role (R-26). B is a customer's
//    account, tenant-owned, one cell, external id, dedicated to Y. Both are
//    accepted CREATING (ADR-045) and polled to ACTIVE; GetAccount B says an
//    external id is set and never returns it. ListAccounts sorts by account
//    id (the GSI-1 sort key; exact-length match).
const accountsInListOrder = [accountA, accountB].sort();
const accounts = probeBatch([
  api('PutAccount without a role pair', 'PUT', `accounts/${unregisteredAccount}`, 400, { body: { owner: 'VENDOR', maxCells: 1 } }),
  api('PutAccount A with an external id its pair does not require', 'PUT', `accounts/${accountA}`, 400, {
    body: { owner: 'TENANT', maxCells: 1, externalId: accountBExternalId },
    match: { message: `re:${fleetName}-cell-provisioning does not require the external id` },
  }),
  api('PutAccount with 101 applicationIds', 'PUT', `accounts/${accountA}`, 400, {
    body: { owner: 'VENDOR', maxCells: 2, applicationIds: Array.from({ length: 101 }, (_, i) => `integ-app-${i}`) },
  }),
  api('PutAccount A', 'PUT', `accounts/${accountA}`, 202, {
    body: { owner: 'VENDOR', maxCells: 2 },
    match: { account: { accountId: accountA, status: 'CREATING', owner: 'VENDOR', maxCells: 2, cellCount: 0, externalIdConfigured: false } },
  }),
  api('PutAccount B without an external id', 'PUT', `accounts/${accountB}`, 400, {
    body: { owner: 'TENANT', maxCells: 1 },
    match: { message: 're:externalId is required' },
  }),
  api('PutAccount B with the wrong external id', 'PUT', `accounts/${accountB}`, 400, {
    body: { owner: 'TENANT', maxCells: 1, externalId: `${accountBExternalId}-wrong` },
    match: { message: `re:${fleetName}-(cell|tenant)-provisioning could not be assumed` },
  }),
  api('PutAccount B', 'PUT', `accounts/${accountB}`, 202, {
    body: { owner: 'TENANT', maxCells: 1, externalId: accountBExternalId, applicationIds: [APP_Y] },
    match: {
      account: { accountId: accountB, status: 'CREATING', owner: 'TENANT', maxCells: 1, cellCount: 0, externalIdConfigured: true, applicationIds: [APP_Y] },
    },
  }),
  pollActive('GetAccount A', `accounts/${accountA}`, 'account', { maxCells: 2, cellCount: 0 }),
  pollActive('GetAccount B', `accounts/${accountB}`, 'account', {
    maxCells: 1, cellCount: 0, externalIdConfigured: true, externalId: 'absent:', applicationIds: [APP_Y],
  }),
  api('ListAccounts two', 'GET', 'accounts', 200, {
    match: {
      accounts: accountsInListOrder.map((accountId) => ({ accountId, status: 'ACTIVE', cellCount: 0, maxCells: accountId === accountA ? 2 : 1 })),
    },
  }),
]);

// 4. Tenants run no build (§5.1): three records, no cell, no build.
//    CreateTenant answers 202 with the tenant CREATING (ADR-045); its
//    TENANT_CREATE event runs no hook here, and GetTenant polls each to
//    ACTIVE. T3 is updated and deleted again straight away (empty-only
//    delete, 202, polled to 404), and a deployment for it is then a 404 —
//    like one for an unregistered application.
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

// ListTenants sorts by tenant id (the GSI-2 sort key, a ULID, so creation
// order). Exact-length match: three tenants, no cell anywhere yet.
const tenantsCreated = probeBatch([
  acceptedCreating('CreateTenant T1', createTenant1, 'tenant'),
  acceptedCreating('CreateTenant T2', createTenant2, 'tenant'),
  acceptedCreating('CreateTenant T3', createTenant3, 'tenant'),
  pollActive('GetTenant T1', `tenants/${tenantId1}`, 'tenant', { tenantId: tenantId1, name: 'integ-tenant-1', deploymentCount: 0 }),
  pollActive('GetTenant T2', `tenants/${tenantId2}`, 'tenant', { deploymentCount: 0 }),
  pollActive('GetTenant T3', `tenants/${tenantId3}`, 'tenant', { deploymentCount: 0 }),
  api('ListTenants three', 'GET', 'tenants', 200, {
    match: { tenants: [{ tenantId: tenantId1 }, { tenantId: tenantId2 }, { tenantId: tenantId3 }] },
  }),
  api('ListCells none', 'GET', 'cells', 200, { match: { cells: [] } }),
]);

// 1 (reader checks, R-36). The tenants above exist, so a reader's reads have
// something to return and its writes have something to change. API Gateway
// refuses every write against the reader's GET-only policy (403); the
// operator's read afterwards proves nothing was written.
const threeTenants = { tenants: [{ tenantId: tenantId1 }, { tenantId: tenantId2 }, { tenantId: tenantId3 }] };
const readerAndUnlisted = probeBatch([
  // The reader's first call is a POST, so its cached policy is filled by a
  // write: its reads must still pass (R-36, grant-only policy).
  api('reader CreateTenant', 'POST', 'tenants', 403, { as: 'reader', body: { name: 'integ-reader-must-not-create' } }),
  api('reader ListTenants', 'GET', 'tenants', 200, { as: 'reader', match: threeTenants }),
  api('reader GetTenant', 'GET', `tenants/${tenantId1}`, 200, { as: 'reader', match: { tenant: { tenantId: tenantId1 } } }),
  api('reader GetApplication', 'GET', `applications/${APP_X}`, 200, { as: 'reader' }),
  api('reader UpdateTenant', 'PUT', `tenants/${tenantId1}`, 403, { as: 'reader', body: { description: 'written by a reader' } }),
  api('reader DeleteTenant', 'DELETE', `tenants/${tenantId2}`, 403, { as: 'reader' }),
  api('reader PutApplication', 'PUT', `applications/${APP_X}`, 403, { as: 'reader', body: definition }),
  api('unlisted ListTenants', 'GET', 'tenants', 403, { as: 'unlisted' }),
  api('unlisted CreateTenant', 'POST', 'tenants', 403, { as: 'unlisted', body: { name: 'integ-unlisted-must-not-create' } }),
]);
// 1 (machine clients, R-38). A client-credentials token has no `aud` and a
// `sub` equal to its client id. The listed client reads and is refused on a
// write; the unlisted client, with the same role, is refused on a read; the
// listed client's token for another scope is refused on a read.
const machineExpect = (status: number, scope = 'control-plane/read') => ExpectedResult.objectLike({
  Payload: JSON.stringify({ status, hasAud: false, subIsClient: true, role: 'control-plane:reader', scope }),
});
const machineCall = (clientId: string, method: string, pathPart: string, body?: object, scope?: string) =>
  integ.assertions.invokeFunction({
    functionName: machineProbe.functionName,
    payload: JSON.stringify({ clientId, method, scope, url: `${apiUrl}${pathPart}`, body: body === undefined ? undefined : JSON.stringify(body) }),
  });
const machineListTenants = machineCall(listedMachineClient.userPoolClientId, 'GET', 'tenants').expect(machineExpect(200));
const machineGetTenant1 = machineCall(listedMachineClient.userPoolClientId, 'GET', `tenants/${tenantId1}`).expect(machineExpect(200));
const machineCreateTenant = machineCall(listedMachineClient.userPoolClientId, 'POST', 'tenants', { name: 'integ-machine-must-not-create' })
  .expect(machineExpect(403));
const unlistedMachineListTenants = machineCall(unlistedMachineClient.userPoolClientId, 'GET', 'tenants').expect(machineExpect(403));
const machineOtherScopeListTenants = machineCall(
  listedMachineClient.userPoolClientId, 'GET', 'tenants', undefined, 'control-plane/other',
).expect(machineExpect(403, 'control-plane/other'));

// Nothing the reader, the unlisted role or the machine clients tried was
// written: still three tenants, T1 unchanged.
const afterReader = probeBatch([
  api('ListTenants', 'GET', 'tenants', 200, { match: threeTenants }),
  api('GetTenant T1', 'GET', `tenants/${tenantId1}`, 200, {
    match: { tenant: { tenantId: tenantId1, name: 'integ-tenant-1', description: 'created by the integ test' } },
  }),
]);

// UpdateTenant stages the merged name and description in `pending` and
// answers 202 UPDATING; the commit makes them live (R-48, R-50).
const tenant3Lifecycle = probeBatch([
  api('UpdateTenant T3', 'PUT', `tenants/${tenantId3}`, 202, {
    body: { description: 'about to be deleted' },
    match: { tenant: { status: 'UPDATING', deploymentCount: 0, pending: { name: 'integ-tenant-3', description: 'about to be deleted' } } },
  }),
  pollActive('GetTenant T3 updated', `tenants/${tenantId3}`, 'tenant', { description: 'about to be deleted', deploymentCount: 0, pending: 'absent:' }),
  api('DeleteTenant T3', 'DELETE', `tenants/${tenantId3}`, 202, { match: { tenant: { tenantId: tenantId3, status: 'DELETING' } } }),
  pollGone('GetTenant T3 deleted', `tenants/${tenantId3}`),
  api('CreateDeployment for the deleted T3', 'POST', `tenants/${tenantId3}/deployments`, 404, {
    body: { applicationId: APP_X, adminEmail: 'success+integ-t3@simulator.amazonses.com' },
  }),
  api('CreateDeployment of an unregistered application', 'POST', `tenants/${tenantId1}/deployments`, 404, {
    body: { applicationId: 'integ-nope', adminEmail: 'success+integ-t1@simulator.amazonses.com' },
  }),
]);

// 5. Deploy X for T1 — CreateDeployment carries no resource definition
//    (P-4) and no accountId: placement considers the vendor-owned accounts
//    that admit X (A, shared), creates cell 1 in A implicitly and returns the
//    deployment CREATING with its cellId. Carries a clientToken for the
//    replay below.
//    Parameters are checked first (R-33): without the required one, or with
//    an undeclared one, the request is a 400 and nothing is written.
const createT1XMissingRequired = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}/deployments`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ applicationId: APP_X, adminEmail: 'success+integ-t1-x@simulator.amazonses.com' }),
  })
  .expect(ExpectedResult.objectLike({ status: 400, body: { message: Match.stringLikeRegexp('ALLOWED_EMAIL_DOMAIN') } }));
const createT1XUndeclared = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}/deployments`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      applicationId: APP_X,
      adminEmail: 'success+integ-t1-x@simulator.amazonses.com',
      parameters: { ...parametersX, NOT_DECLARED: 'x' },
    }),
  })
  .expect(ExpectedResult.objectLike({ status: 400, body: { message: Match.stringLikeRegexp('NOT_DECLARED') } }));

const clientToken1 = 'integ-retry-token-t1-x';
const createT1XBody = JSON.stringify({
  applicationId: APP_X,
  adminEmail: 'success+integ-t1-x@simulator.amazonses.com',
  parameters: parametersX,
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
        // The supplied value only; the LOG_LEVEL default is not merged in.
        parameters: parametersX,
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
        // A new cell starts with no values of its own. (objectLike cannot
        // assert an empty map; the cell build check below shows the default.)
        parameters: {},
      },
    }),
  );

// 1 (reader, continued, R-36): with a deployment, a cell and both accounts in
// place, the reader's other seven GET operations return 200 as well; GetHook
// and ListHooks follow in step 16, once a hook is registered, so all twelve
// reader operations are proven live.
const readerReads = probeBatch([
  `deployments?tenantId=${tenantId1}`,
  `tenants/${tenantId1}/deployments/${APP_X}`,
  'cells',
  `cells/${cellId1}`,
  'accounts',
  `accounts/${accountA}`,
  'applications',
].map((apiPath) => api(`reader GET ${apiPath}`, 'GET', apiPath, 200, { as: 'reader' })));

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

// The tenant create build received the supplied value and the LOG_LEVEL
// default; the cell create build the CELL_SIZE default and no tenant
// parameter (R-32, R-34, §6.1).
const t1XCreateParameters = expectBuildParameters('t1x-create', 'tenant', {
  PARAM_ALLOWED_EMAIL_DOMAIN: 'example.com',
  PARAM_LOG_LEVEL: 'info',
});
const cell1CreateParameters = expectBuildParameters('cell1-create', 'cell', { PARAM_CELL_SIZE: 'small' });

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
// Y declares nothing: neither of its builds got a PARAM_ variable.
const t1YCreateParameters = expectBuildParameters('t1y-create', 'tenant', {});
const cell2CreateParameters = expectBuildParameters('cell2-create', 'cell', {});

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
    body: JSON.stringify({ applicationId: APP_X, adminEmail: 'success+integ-t1-x@simulator.amazonses.com', parameters: parametersX }),
  })
  .expect(ExpectedResult.objectLike({ status: 409, headers: { 'x-amzn-errortype': ['ConflictError'] } }));
const deleteTenant1Occupied = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 409 }));

// 7. Replay the IDENTICAL request (same clientToken, same parameters): the
//    original deployment comes back — same cell, and already ACTIVE, which a
//    fresh create could never be (it would start CREATING). No new
//    deployment, no new cell, no slot (ADR-017). The token with a different
//    applicationId, or a different parameter value, is a request-hash
//    mismatch → 409.
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
const reuseTokenOtherValue = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}/deployments`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      applicationId: APP_X,
      adminEmail: 'success+integ-t1-x@simulator.amazonses.com',
      parameters: { ALLOWED_EMAIL_DOMAIN: 'example.org' },
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
    body: JSON.stringify({ applicationId: APP_X, adminEmail: 'success+integ-t2-x@simulator.amazonses.com', parameters: parametersX }),
  })
  // The error TYPE tells it apart from a ConflictError 409 (ADR-026).
  .expect(ExpectedResult.objectLike({ status: 409, headers: { 'x-amzn-errortype': ['InsufficientCapacityError'] } }));

// 9. Admission (ADR-033): B admits only Y, so X targeted at B is a 400 — a
//    wrong account, not a full one.
const createT2XAtB = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}/deployments`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      applicationId: APP_X,
      adminEmail: 'success+integ-t2-x@simulator.amazonses.com',
      accountId: accountB,
      parameters: parametersX,
    }),
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
const t2YCreateParameters = expectBuildParameters('t2y-create', 'tenant', {});
const cell3CreateParameters = expectBuildParameters('cell3-create', 'cell', {});

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
//     owner → 409. T4 is created for the attempt (polled to ACTIVE, so
//     the refusal is the capacity, not a tenant in flight) and deleted
//     again (202, polled to 404).
const createTenant4 = integ.assertions.httpApiCall(`${apiUrl}tenants`, {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({ name: 'integ-tenant-4' }),
});
const tenantId4 = createTenant4.getAttString('body.tenant.tenantId');

const accountFull = probeBatch([
  acceptedCreating('CreateTenant T4', createTenant4, 'tenant'),
  pollActive('GetTenant T4', `tenants/${tenantId4}`, 'tenant', { deploymentCount: 0 }),
  api('CreateDeployment T4/Y at the full B', 'POST', `tenants/${tenantId4}/deployments`, 409, {
    body: { applicationId: APP_Y, adminEmail: 'success+integ-t4-y@simulator.amazonses.com', accountId: accountB },
    errorType: 'InsufficientCapacityError',
  }),
  api('DeleteAccount B occupied', 'DELETE', `accounts/${accountB}`, 409),
  api('DeleteApplication Y occupied', 'DELETE', `applications/${APP_Y}`, 409),
  api('PutAccount B with another owner', 'PUT', `accounts/${accountB}`, 409, {
    body: { owner: 'VENDOR', maxCells: 1, externalId: accountBExternalId, applicationIds: [APP_Y] },
  }),
  api('DeleteTenant T4', 'DELETE', `tenants/${tenantId4}`, 202, { match: { tenant: { tenantId: tenantId4, status: 'DELETING' } } }),
  pollGone('GetTenant T4 deleted', `tenants/${tenantId4}`),
]);

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

// A metadata update (202, polled to ACTIVE) never touches the count. A
// replaced definition reaches only cells created afterwards (P-4): Y's
// maxTenants changes, cells 2 and 3 keep their stamp. The replace is staged
// in `pending` (R-48) and committed by APPLICATION_UPDATE, which runs no hook
// here.
const tenant1AndYReplaced = probeBatch([
  api('UpdateTenant T1', 'PUT', `tenants/${tenantId1}`, 202, {
    body: { description: 'updated by the integ test' },
    match: { tenant: { status: 'UPDATING', deploymentCount: 2, pending: { description: 'updated by the integ test' } } },
  }),
  pollActive('GetTenant T1 updated', `tenants/${tenantId1}`, 'tenant', { description: 'updated by the integ test', deploymentCount: 2 }),
  api('PutApplication Y replaced', 'PUT', `applications/${APP_Y}`, 202, {
    body: { ...definition, maxTenants: 3, placementStrategy: 'ROUND_ROBIN' },
    match: { application: { status: 'UPDATING', cellCount: 2, pending: { maxTenants: 3, placementStrategy: 'ROUND_ROBIN' } } },
  }),
  pollActive('GetApplication Y replaced', `applications/${APP_Y}`, 'application', {
    maxTenants: 3, placementStrategy: 'ROUND_ROBIN', cellCount: 2, pending: 'absent:',
  }),
  api('GetCell 3 still stamped', 'GET', `cells/${cellId3}`, 200, { match: { cell: { maxTenants: 1 } } }),
  api('GetCell 2 still stamped', 'GET', `cells/${cellId2}`, 200, { match: { cell: { maxTenants: 1 } } }),
]);

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
const t1XUpdateParameters = expectBuildParameters('t1x-update', 'tenant', {
  PARAM_ALLOWED_EMAIL_DOMAIN: 'example.com',
  PARAM_LOG_LEVEL: 'info',
});

/** One UpdateDeployment of T1/X with a body. */
function updateT1XWith(body: Record<string, unknown>) {
  return integ.assertions.httpApiCall(`${apiUrl}tenants/${tenantId1}/deployments/${APP_X}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify(body),
  });
}
/** Polls T1/X back to ACTIVE after an update. */
function waitForT1XActiveAgain() {
  return integ.assertions
    .httpApiCall(`${apiUrl}tenants/${tenantId1}/deployments/${APP_X}`, { method: 'GET', headers: authHeaders })
    .expect(ExpectedResult.objectLike({ status: 200, body: { deployment: { status: 'ACTIVE' } } }))
    .waitForAssertions(singleBuildPoll);
}
/** One UpdateCell of cell 1 with a body. */
function updateCell1With(body: Record<string, unknown>) {
  return integ.assertions.httpApiCall(`${apiUrl}cells/${cellId1}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify(body),
  });
}
/** Polls cell 1 back to ACTIVE after an update. */
function waitForCell1ActiveAgain() {
  return integ.assertions
    .httpApiCall(`${apiUrl}cells/${cellId1}`, { method: 'GET', headers: authHeaders })
    .expect(ExpectedResult.objectLike({ status: 200, body: { cell: { status: 'ACTIVE' } } }))
    .waitForAssertions(singleBuildPoll);
}

// The merge (R-33): setting LOG_LEVEL keeps ALLOWED_EMAIL_DOMAIN, and the
// update build gets both.
const updateT1XLogLevel = updateT1XWith({ parameters: { LOG_LEVEL: 'debug' } })
  .expect(ExpectedResult.objectLike({ status: 202, body: { deployment: { status: 'UPDATING' } } }));
const waitForT1XLogLevel = waitForT1XActiveAgain();
const t1XDebugParameters = expectBuildParameters('t1x-update-debug', 'tenant', {
  PARAM_ALLOWED_EMAIL_DOMAIN: 'example.com',
  PARAM_LOG_LEVEL: 'debug',
});
// Refused before anything is written: removing a required parameter, one
// name in both lists, a cell parameter name, a control character.
const updateT1XRefusals = [
  { removeParameters: ['ALLOWED_EMAIL_DOMAIN'] },
  { parameters: { LOG_LEVEL: 'warn' }, removeParameters: ['LOG_LEVEL'] },
  { parameters: { CELL_SIZE: 'large' } },
  // JSON.stringify sends the U+0001 as the escape \u0001.
  { parameters: { LOG_LEVEL: 'de\u0001bug' } },
].map((body) => updateT1XWith(body).expect(ExpectedResult.objectLike({ status: 400 })));
const getT1XAfterRefusals = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}/deployments/${APP_X}`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: { deployment: { status: 'ACTIVE' }, parameters: { ALLOWED_EMAIL_DOMAIN: 'example.com', LOG_LEVEL: 'debug' } },
    }),
  );

const updateCell3 = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId3}`, { method: 'PUT', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 202, body: { cell: { status: 'UPDATING' } } }));
const waitForCell3Updated = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId3}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { cell: { status: 'ACTIVE' } } }))
  .waitForAssertions(singleBuildPoll);
const cell3UpdateParameters = expectBuildParameters('cell3-update', 'cell', {});

// Cell parameters (R-34): set CELL_SIZE on cell 1, then remove it; the
// cell update build gets the value, then the default again.
const updateCell1Large = updateCell1With({ parameters: { CELL_SIZE: 'large' } })
  .expect(ExpectedResult.objectLike({ status: 202, body: { cell: { status: 'UPDATING' } } }));
const waitForCell1Large = waitForCell1ActiveAgain();
const cell1LargeParameters = expectBuildParameters('cell1-update-large', 'cell', { PARAM_CELL_SIZE: 'large' });
const getCell1Large = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId1}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { parameters: { CELL_SIZE: 'large' } } }));
// A tenant parameter or an undeclared name on UpdateCell → 400.
const updateCell1Refusals = [{ parameters: { LOG_LEVEL: 'debug' } }, { parameters: { NOT_DECLARED: 'x' } }].map((body) =>
  updateCell1With(body).expect(ExpectedResult.objectLike({ status: 400 })),
);
const updateCell1Remove = updateCell1With({ removeParameters: ['CELL_SIZE'] })
  .expect(ExpectedResult.objectLike({ status: 202, body: { cell: { status: 'UPDATING' } } }));
const waitForCell1Removed = waitForCell1ActiveAgain();
const cell1RemovedParameters = expectBuildParameters('cell1-update-removed', 'cell', { PARAM_CELL_SIZE: 'small' });

// 14. Declarations change under live records (ADR-039, ADR-040). A put
//     without the lists keeps them; changed defaults reach the existing
//     deployment and cell on their next build; a newly required parameter
//     makes the next UpdateDeployment of a deployment lacking it a 400.
// Each PutApplication answers 202 UPDATING and is polled to ACTIVE (ADR-045).
const declarationsKept = probeBatch([
  api('PutApplication X without lists', 'PUT', `applications/${APP_X}`, 202, { body: definition, match: { application: { status: 'UPDATING' } } }),
  pollActive('GetApplication X kept', `applications/${APP_X}`, 'application', declaredX),
  api('PutApplication X with new defaults', 'PUT', `applications/${APP_X}`, 202, {
    body: {
      ...definition,
      parameters: [{ name: 'ALLOWED_EMAIL_DOMAIN', required: true }, { name: 'LOG_LEVEL', default: 'warn' }],
      cellParameters: [{ name: 'CELL_SIZE', default: 'medium' }],
    },
    match: { application: { status: 'UPDATING' } },
  }),
  pollActive('GetApplication X new defaults', `applications/${APP_X}`, 'application', {
    parameters: [{ name: 'ALLOWED_EMAIL_DOMAIN', required: true }, { name: 'LOG_LEVEL', default: 'warn' }],
    cellParameters: [{ name: 'CELL_SIZE', default: 'medium' }],
  }),
]);
const updateT1XDropLogLevel = updateT1XWith({ removeParameters: ['LOG_LEVEL'] })
  .expect(ExpectedResult.objectLike({ status: 202 }));
const waitForT1XDropLogLevel = waitForT1XActiveAgain();
const t1XWarnParameters = expectBuildParameters('t1x-update-warn', 'tenant', {
  PARAM_ALLOWED_EMAIL_DOMAIN: 'example.com',
  PARAM_LOG_LEVEL: 'warn',
});
const updateCell1Medium = updateCell1With({}).expect(ExpectedResult.objectLike({ status: 202 }));
const waitForCell1Medium = waitForCell1ActiveAgain();
const cell1MediumParameters = expectBuildParameters('cell1-update-medium', 'cell', { PARAM_CELL_SIZE: 'medium' });
const tierRequired = probeBatch([
  api('PutApplication X with TIER required', 'PUT', `applications/${APP_X}`, 202, {
    body: { ...definition, parameters: [{ name: 'LOG_LEVEL', default: 'warn' }, { name: 'TIER', required: true }] },
    match: { application: { status: 'UPDATING' } },
  }),
  pollActive('GetApplication X with TIER required', `applications/${APP_X}`, 'application', {
    parameters: [{ name: 'LOG_LEVEL', default: 'warn' }, { name: 'TIER', required: true }],
    // Not sent, so kept.
    cellParameters: [{ name: 'CELL_SIZE', default: 'medium' }],
  }),
  api('UpdateDeployment T1/X without TIER', 'PUT', `tenants/${tenantId1}/deployments/${APP_X}`, 400, { body: {}, match: { message: 're:TIER' } }),
  api('GetDeployment T1/X still ACTIVE', 'GET', `tenants/${tenantId1}/deployments/${APP_X}`, 200, { match: { deployment: { status: 'ACTIVE' } } }),
]);

// 15. Occupancy guard: deleting a cell that still holds a deployment → 409
//     (ADR-014). Then delete T1/X (it lacks the now-required TIER, which
//     never blocks a delete): the record disappears when the tenant
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
// The delete build got the stale ALLOWED_EMAIL_DOMAIN (no longer declared,
// still passed), the LOG_LEVEL default, and no TIER (R-32).
const t1XDeleteParameters = expectBuildParameters('t1x-delete', 'tenant', {
  PARAM_ALLOWED_EMAIL_DOMAIN: 'example.com',
  PARAM_LOG_LEVEL: 'warn',
});

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
// build only. X now requires TIER instead of ALLOWED_EMAIL_DOMAIN.
const createT2X = integ.assertions.httpApiCall(`${apiUrl}tenants/${tenantId2}/deployments`, {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({ applicationId: APP_X, adminEmail: 'success+integ-t2-x@simulator.amazonses.com', parameters: { TIER: 'gold' } }),
});
const waitForT2XActive = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}/deployments/${APP_X}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { deployment: { status: 'ACTIVE', cellId: cellId1 } } }))
  .waitForAssertions(singleBuildPoll);
const t2XCreateParameters = expectBuildParameters('t2x-create', 'tenant', { PARAM_LOG_LEVEL: 'warn', PARAM_TIER: 'gold' });

// 16. Hooks (ADR-044, spec §10 step 16). Global hooks are registered through
//     the API; application hooks are part of Z's definition and are stamped
//     onto its cells. Both kinds run the one test hook script, which records
//     what it saw in the ledger (see the probe above) and fails on demand.
//     Hook builds poll every 60 seconds (R-46), so every hook adds about two
//     minutes to the event it wraps. The checks between two waits run as one
//     probe batch (an assertion stack holds 200 outputs at most).
const HOOK_G = 'g-audit';
const HOOK_P = 'p-gate';
const allHookEvents = ['CELL_CREATE', 'CELL_UPDATE', 'CELL_DELETE', 'DEPLOYMENT_CREATE', 'DEPLOYMENT_UPDATE', 'DEPLOYMENT_DELETE'];
const hookScript = 'integ-hook/hook.sh';
/** A hook definition of the test hook script; 5 minutes is the smallest run timeout the spec allows. */
function hookDefinition(events: string[], phase: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { events, phase, source: definition.source, script: hookScript, timeoutMinutes: 5, ...extra };
}
const hookG = { hookId: HOOK_G, phase: 'POST', script: hookScript, timeoutMinutes: 5, source: definition.source };

// Application Z: Y's source and scripts (but for one tenant create script that
// writes a script output, R-43), two tenants per cell, three parameters and
// two application hooks. HOOK_FAIL steers the hooks; the other two carry the
// API function's name and the workflow's ARN, which R-42 hands a hook neither
// of, from the stack's outputs.
const appHookDefinitions = [
  { hookId: 'a-pre', ...hookDefinition(['DEPLOYMENT_DELETE'], 'PRE') },
  { hookId: 'b-post', ...hookDefinition(['DEPLOYMENT_CREATE'], 'POST') },
];
const definitionZ = {
  ...definition,
  maxTenants: 2,
  tenantScripts: { ...definition.tenantScripts, create: 'integ-z/create.sh' },
  parameters: [
    { name: 'HOOK_FAIL', default: 'no' },
    { name: 'API_FUNCTION_NAME', default: apiFunctionName },
    { name: 'WORKFLOW_ARN', default: stateMachineArn },
  ],
  hooks: appHookDefinitions,
};
const fillerIds = ['filler-1', 'filler-2', 'filler-3', 'filler-4'];

// The hook API and application Z, in one batch. A definition that breaks R-39
// in one field each (an unknown event, a phase outside PRE|POST, a timeout of 4
// and of 31, a script path with a space, a source location with userinfo, a
// source ref holding a control character, an empty event list, a repeated
// event) is a 400, and so is a reader's PutHook with a 403, nothing written.
// G (POST, all six events) registers at revision 1 and re-sent unchanged at 2.
// The hook counter (P-6): four more hooks make five, the sixth is a 409
// ConflictError whose remedy is DeleteHook; the four are deleted again, the
// first one twice, the second delete a 404. With a hook registered, the
// reader's last two GET operations return 200, so all twelve are proven live
// (step 1, R-36). None of the hooks registered here runs: no operation is
// accepted while they exist.
const hooksApi = probeBatch([
  api('ListHooks empty', 'GET', 'hooks', 200, { match: { hooks: [] } }),
  ...[
    ['unknown event', hookDefinition(['CELL_NOPE'], 'POST')],
    ['phase outside PRE|POST', hookDefinition(['CELL_CREATE'], 'MID')],
    ['timeout of 4', hookDefinition(['CELL_CREATE'], 'POST', { timeoutMinutes: 4 })],
    ['timeout of 31', hookDefinition(['CELL_CREATE'], 'POST', { timeoutMinutes: 31 })],
    ['script path with a space', hookDefinition(['CELL_CREATE'], 'POST', { script: 'integ hook/hook.sh' })],
    ['source location with userinfo', hookDefinition(['CELL_CREATE'], 'POST', { source: { type: 'GITHUB', location: 'https://u:p@host/r.git' } })],
    // JSON.stringify sends the U+0001 as the escape \u0001.
    ['source ref with a control character', hookDefinition(['CELL_CREATE'], 'POST', { source: { ...definition.source, sourceVersion: 'ma\u0001in' } })],
    ['empty event list', hookDefinition([], 'POST')],
    ['repeated event', hookDefinition(['CELL_CREATE', 'CELL_CREATE'], 'POST')],
  ].map(([name, body]) => api(`PutHook refused: ${name as string}`, 'PUT', 'hooks/refused', 400, { body })),
  api('reader PutHook', 'PUT', `hooks/${HOOK_G}`, 403, { as: 'reader', body: hookDefinition(allHookEvents, 'POST') }),
  api('GetHook unregistered', 'GET', `hooks/${HOOK_G}`, 404),
  api('DeleteHook unregistered', 'DELETE', `hooks/${HOOK_G}`, 404),
  api('ListHooks still empty', 'GET', 'hooks', 200, { match: { hooks: [] } }),
  api('PutHook G', 'PUT', `hooks/${HOOK_G}`, 200, { body: hookDefinition(allHookEvents, 'POST'), match: { hook: { ...hookG, revision: 1 } } }),
  api('PutHook G again', 'PUT', `hooks/${HOOK_G}`, 200, { body: hookDefinition(allHookEvents, 'POST'), match: { hook: { ...hookG, revision: 2 } } }),
  api('GetHook G', 'GET', `hooks/${HOOK_G}`, 200, { match: { hook: { ...hookG, revision: 2 } } }),
  api('reader GetHook', 'GET', `hooks/${HOOK_G}`, 200, { as: 'reader', match: { hook: { hookId: HOOK_G } } }),
  api('reader ListHooks', 'GET', 'hooks', 200, { as: 'reader', match: { hooks: [{ hookId: HOOK_G }] } }),
  ...fillerIds.map((hookId) => api(`PutHook ${hookId}`, 'PUT', `hooks/${hookId}`, 200, {
    body: hookDefinition(['CELL_DELETE'], 'POST'),
    match: { hook: { hookId, revision: 1 } },
  })),
  api('PutHook sixth', 'PUT', 'hooks/filler-5', 409, { body: hookDefinition(['CELL_DELETE'], 'POST'), errorType: 'ConflictError' }),
  api('ListHooks five', 'GET', 'hooks', 200, { match: { hooks: [...fillerIds, HOOK_G].map((hookId) => ({ hookId })) } }),
  ...fillerIds.map((hookId) => api(`DeleteHook ${hookId}`, 'DELETE', `hooks/${hookId}`, 200, { match: { hook: { hookId } } })),
  api('DeleteHook again', 'DELETE', `hooks/${fillerIds[0]}`, 404),
  api('ListHooks G alone', 'GET', 'hooks', 200, { match: { hooks: [{ hookId: HOOK_G }] } }),
  // Cell 4 needs room: A takes a third cell, staged and committed (ADR-045).
  api('PutAccount A', 'PUT', `accounts/${accountA}`, 202, {
    body: { owner: 'VENDOR', maxCells: 3 },
    match: { account: { accountId: accountA, status: 'UPDATING', maxCells: 2, cellCount: 2, pending: { maxCells: 3 } } },
  }),
  pollActive('GetAccount A with three cells', `accounts/${accountA}`, 'account', { maxCells: 3, cellCount: 2, pending: 'absent:' }),
  // A repeated hook id, six hooks and an id outside the charset are each a 400.
  api('PutApplication Z repeated hook id', 'PUT', `applications/${APP_Z}`, 400, {
    body: { ...definitionZ, hooks: [appHookDefinitions[0], appHookDefinitions[0]] },
  }),
  api('PutApplication Z six hooks', 'PUT', `applications/${APP_Z}`, 400, {
    body: { ...definitionZ, hooks: Array.from({ length: 6 }, (_, i) => ({ ...appHookDefinitions[0], hookId: `hook-${i}` })) },
  }),
  api('PutApplication Z bad hook id', 'PUT', `applications/${APP_Z}`, 400, {
    body: { ...definitionZ, hooks: [{ ...appHookDefinitions[0], hookId: 'A_PRE' }] },
  }),
  api('PutApplication Z', 'PUT', `applications/${APP_Z}`, 202, {
    body: definitionZ,
    match: {
      application: {
        applicationId: APP_Z,
        status: 'CREATING',
        maxTenants: 2,
        cellCount: 0,
        hooks: [{ hookId: 'a-pre', phase: 'PRE' }, { hookId: 'b-post', phase: 'POST' }],
      },
    },
  }),
  pollActive('GetApplication Z', `applications/${APP_Z}`, 'application', { cellCount: 0 }),
]);

// T1/Z creates cell 4 in A: the cell create script, then the tenant create
// script, each with its hooks. Z's parameters all have defaults. Three hook
// builds and two script builds run in this one execution.
const createT1Z = integ.assertions.httpApiCall(`${apiUrl}tenants/${tenantId1}/deployments`, {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({ applicationId: APP_Z, adminEmail: 'success+integ-t1-z@simulator.amazonses.com' }),
});
const cellId4 = createT1Z.getAttString('body.deployment.cellId');
const waitForT1ZActive = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}/deployments/${APP_Z}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { deployment: { status: 'ACTIVE', cellId: cellId4 } } }))
  .waitForAssertions(newCellPoll);

// The order everything ran in (R-45): the cell create script, G on
// CELL_CREATE, the tenant create script, the application post hook, then the
// global post hook, so global hooks wrap the application's. Each story is
// cumulative, so a hook or a script that ran and should not have shows up.
const storyCreated = [
  'script create cell',
  `hook GLOBAL/${HOOK_G} CELL_CREATE POST a1`,
  'script create tenant T1',
  'hook APPLICATION/b-post DEPLOYMENT_CREATE POST T1 a1',
  `hook GLOBAL/${HOOK_G} DEPLOYMENT_CREATE POST T1 a1`,
];
const storyUpdated = [...storyCreated, 'script update tenant T1', `hook GLOBAL/${HOOK_G} DEPLOYMENT_UPDATE POST T1 a1`];
const storyCellUpdated = [...storyUpdated, 'script update cell', `hook GLOBAL/${HOOK_G} CELL_UPDATE POST a1`];
const storyGated = [...storyCellUpdated, `hook GLOBAL/${HOOK_P} DEPLOYMENT_CREATE PRE T2 a1`];
const storyDeleteFailing = [
  ...storyGated,
  'hook APPLICATION/a-pre DEPLOYMENT_DELETE PRE T2 a1',
  'hook APPLICATION/a-pre DEPLOYMENT_DELETE PRE T2 a2',
  'hook APPLICATION/a-pre DEPLOYMENT_DELETE PRE T2 a3',
  'script delete tenant T2',
  `hook GLOBAL/${HOOK_G} DEPLOYMENT_DELETE POST T2 a1`,
];
const storyPostFailed = [...storyDeleteFailing, 'script create tenant T2', 'hook APPLICATION/b-post DEPLOYMENT_CREATE POST T2 a1'];
const storyDeletePassing = [
  ...storyPostFailed,
  'hook APPLICATION/a-pre DEPLOYMENT_DELETE PRE T2 a1',
  'script delete tenant T2',
  `hook GLOBAL/${HOOK_G} DEPLOYMENT_DELETE POST T2 a1`,
];
const storyDeleteT1 = [
  ...storyDeletePassing,
  'hook APPLICATION/a-pre DEPLOYMENT_DELETE PRE T1 a1',
  'script delete tenant T1',
  `hook GLOBAL/${HOOK_G} DEPLOYMENT_DELETE POST T1 a1`,
];
const storyCellDeleted = [...storyDeleteT1, 'script delete cell', `hook GLOBAL/${HOOK_G} CELL_DELETE POST a1`];

// What a hook record holds, as the probe returns it.
const allowedParams = ['PARAM_API_FUNCTION_NAME', 'PARAM_HOOK_FAIL', 'PARAM_WORKFLOW_ARN'];
const recordOf = (fields: Record<string, unknown>) => ({
  ATTEMPT: '1',
  APPLICATION_ID: APP_Z,
  CELL_ACCOUNT_ID: 'A',
  CELL_ID: 'cell4',
  PHASE: 'POST',
  PARAM_HOOK_FAIL: 'no',
  denied: null,
  hasExecutionId: true,
  hasOperatorId: true,
  paramNames: allowedParams,
  scriptOutputsSet: true,
  tenantNameSet: true,
  ...fields,
});
// Cell 4 and T1/Z as the API reports them: the stamped application hooks, the
// global hook that ran in the last event with the revision it ran at (R-40),
// and the counters. An S3 source names no ref and reports no resolved commit,
// so those two fields of `lastGlobalHooks` are absent; the test has no git
// source to resolve (integration-test.md).
const lastGlobalHooksG = [{ hookId: HOOK_G, phase: 'POST', revision: 2 }];
const t1ZCreated = probeBatch([
  api('GetCell 4', 'GET', `cells/${cellId4}`, 200, {
    match: {
      cell: {
        cellId: cellId4,
        applicationId: APP_Z,
        accountId: accountA,
        status: 'ACTIVE',
        tenantCount: 1,
        maxTenants: 2,
        hooks: [
          { hookId: 'a-pre', phase: 'PRE', events: ['DEPLOYMENT_DELETE'] },
          { hookId: 'b-post', phase: 'POST', events: ['DEPLOYMENT_CREATE'] },
        ],
        lastGlobalHooks: lastGlobalHooksG,
      },
    },
  }),
  api('GetDeployment T1/Z', 'GET', `tenants/${tenantId1}/deployments/${APP_Z}`, 200, {
    match: {
      deployment: { status: 'ACTIVE', cellId: cellId4, lastGlobalHooks: lastGlobalHooksG },
      hooks: [{ hookId: 'a-pre' }, { hookId: 'b-post' }],
    },
  }),
  api('GetAccount A', 'GET', `accounts/${accountA}`, 200, { match: { account: { cellCount: 3, maxCells: 3 } } }),
  api('GetApplication Z', 'GET', `applications/${APP_Z}`, 200, { match: { application: { cellCount: 1 } } }),
  ledger('story after create', 'story', storyCreated, { cell: 'cell4' }),
  // b-post on T1/Z's create (R-42): the event, the scope, the identities, the
  // first attempt, the parameter the test drives, the script's output as the
  // buildspec re-serialised it (compact: the script wrote a space after the
  // colon), the hook role it ran under and, beside its refused SSM write, the
  // refusals R-41's deny gives it: StartExecution on the workflow and Invoke
  // of the API function, unqualified and with $LATEST, each with a forged read
  // event.
  ledger('b-post record', 'record', recordOf({
    EVENT: 'DEPLOYMENT_CREATE',
    HOOK_ID: 'b-post',
    HOOK_SCOPE: 'APPLICATION',
    SCRIPT_OUTPUTS: '{"endpoint":"T1.example.com"}',
    TENANT_ID: 'T1',
    callerRole: `${fleetName}-app-hook`,
    denied: { invoke: 'AccessDenied', invokeLatest: 'AccessDenied', ssmWriteGlobal: 'AccessDenied', startExecution: 'AccessDenied' },
  }), { hookId: 'b-post', event: 'DEPLOYMENT_CREATE', tenant: 'T1' }),
  // G on CELL_CREATE: no tenant, no script output ({}), its own hook role.
  ledger('G cell record', 'record', recordOf({
    EVENT: 'CELL_CREATE',
    HOOK_ID: HOOK_G,
    HOOK_SCOPE: 'GLOBAL',
    PARAM_HOOK_FAIL: '',
    SCRIPT_OUTPUTS: '{}',
    TENANT_ID: '',
    callerRole: `${fleetName}-global-hook`,
    paramNames: [],
    tenantNameSet: false,
  }), { hookId: HOOK_G, event: 'CELL_CREATE', cell: 'cell4' }),
  // G on the deployment create gets the same script output as b-post.
  ledger('G deployment record', 'record', recordOf({
    EVENT: 'DEPLOYMENT_CREATE',
    HOOK_ID: HOOK_G,
    HOOK_SCOPE: 'GLOBAL',
    SCRIPT_OUTPUTS: '{"endpoint":"T1.example.com"}',
    TENANT_ID: 'T1',
    callerRole: `${fleetName}-global-hook`,
  }), { hookId: HOOK_G, event: 'DEPLOYMENT_CREATE', tenant: 'T1' }),
  // No stray parameter under the test path (a successful denied write would be one).
  ledger('strays', 'strays', [], {}),
], true);

// UpdateDeployment T1/Z runs G on DEPLOYMENT_UPDATE, in an execution of its
// own; UpdateCell on cell 4 runs G on CELL_UPDATE, the one of G's six events
// no other step reaches while G is registered.
const updateT1Z = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}/deployments/${APP_Z}`, { method: 'PUT', headers: authHeaders });
const waitForT1ZUpdated = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}/deployments/${APP_Z}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { deployment: { status: 'ACTIVE', lastGlobalHooks: lastGlobalHooksG } } }))
  .waitForAssertions(singleBuildPoll);
const updateCell4 = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId4}`, { method: 'PUT', headers: authHeaders });
const waitForCell4Updated = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId4}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { cell: { status: 'ACTIVE', lastGlobalHooks: lastGlobalHooksG } } }))
  .waitForAssertions(singleBuildPoll);

// P: a global PRE hook on DEPLOYMENT_CREATE that always fails, so it gates
// every application. G's cell create and deployment create share an
// execution; its update is another.
const gateRegistered = probeBatch([
  ledger('story after updates', 'story', storyCellUpdated, { cell: 'cell4' }),
  ledger('G executions', 'executions', ['CELL_CREATE e1', 'DEPLOYMENT_CREATE T1 e1', 'DEPLOYMENT_UPDATE T1 e2', 'CELL_UPDATE e3'], {
    hookId: HOOK_G,
    cell: 'cell4',
  }),
  api('PutHook P', 'PUT', `hooks/${HOOK_P}`, 200, {
    body: hookDefinition(['DEPLOYMENT_CREATE'], 'PRE'),
    match: { hook: { hookId: HOOK_P, phase: 'PRE', revision: 1 } },
  }),
], true);

// T2/Z's create (HOOK_FAIL = yes, which a-pre reads on the delete below) lands
// in cell 4 and ends CREATE_FAILED with the hook named, before its script: no
// tenant create script, no b-post, no G, no parameter.
const createT2ZGated = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}/deployments`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      applicationId: APP_Z,
      adminEmail: 'success+integ-t2-z@simulator.amazonses.com',
      parameters: { HOOK_FAIL: 'yes' },
    }),
  });
const t2ZParamName = `/application-plane/tenants/${tenantId2}/${APP_Z}`;
const waitForT2ZGated = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}/deployments/${APP_Z}`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: {
        deployment: {
          status: 'CREATE_FAILED',
          cellId: cellId4,
          // The reason names the scope and the hook id (the spec writes GLOBAL/p-gate).
          statusReason: Match.stringLikeRegexp(`(GLOBAL/${HOOK_P}|global hook ${HOOK_P})`),
        },
      },
    }),
  )
  .waitForAssertions(singleBuildPoll);
const gated = probeBatch([
  ledger('story after the gate', 'story', storyGated, { cell: 'cell4' }),
  { kind: 'ssm', name: 'T2/Z parameter absent', names: [t2ZParamName], exists: false },
  api('DeleteHook P', 'DELETE', `hooks/${HOOK_P}`, 200, { match: { hook: { hookId: HOOK_P } } }),
  api('GetHook P', 'GET', `hooks/${HOOK_P}`, 404),
], true);

// DeleteDeployment T2/Z (CREATE_FAILED, HOOK_FAIL = yes): a-pre, a PRE hook,
// fails three times (attempts 1, 2 and 3 of one execution, 60 and 120 seconds
// apart, R-46); the skip is logged and counted, and the delete goes on: the
// tenant delete script runs, G records DEPLOYMENT_DELETE after it, the record
// goes and cell 4 drops to one tenant. A delete's hooks cannot stop it. The
// hook's budget is 3 x (5 + 17) + 3 = 69 minutes; the attempts take about ten.
const hookDeletePoll = {
  totalTimeout: Duration.minutes(30),
  interval: Duration.seconds(30),
};
const deleteT2ZFailing = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}/deployments/${APP_Z}`, { method: 'DELETE', headers: authHeaders });
const waitForT2ZGoneFailing = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}/deployments/${APP_Z}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 404 }))
  .waitForAssertions(hookDeletePoll);
const deletedFailing = probeBatch([
  ledger('story after the failing delete hook', 'story', storyDeleteFailing, { cell: 'cell4' }),
  // The three attempts are one execution's.
  ledger('a-pre attempts', 'attempts', [['1', '2', '3']], { hookId: 'a-pre', event: 'DEPLOYMENT_DELETE', tenant: 'T2' }),
  api('GetCell 4', 'GET', `cells/${cellId4}`, 200, { match: { cell: { tenantCount: 1 } } }),
], true);

// A failing POST hook: T2/Z with HOOK_FAIL = post lands in cell 4, its tenant
// create script runs and creates the parameter, b-post fails, and the record
// ends CREATE_FAILED naming the hook; G does not run (a post hook runs only
// after the hooks before it succeeded).
const createT2ZPostFail = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}/deployments`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      applicationId: APP_Z,
      adminEmail: 'success+integ-t2-z@simulator.amazonses.com',
      parameters: { HOOK_FAIL: 'post' },
    }),
  });
const waitForT2ZPostFailed = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}/deployments/${APP_Z}`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: { deployment: { status: 'CREATE_FAILED', statusReason: Match.stringLikeRegexp('(APPLICATION/b-post|application hook b-post)') } },
    }),
  )
  .waitForAssertions(singleBuildPoll);
const postFailed = probeBatch([
  ledger('story after the failing post hook', 'story', storyPostFailed, { cell: 'cell4' }),
  { kind: 'ssm', name: 'T2/Z parameter present', names: [t2ZParamName], exists: true },
], true);

// DeleteDeployment T2/Z again: a-pre passes now (HOOK_FAIL = post), the tenant
// delete script empties the namespace and cell 4 is back to one tenant.
const deleteT2ZPassing = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}/deployments/${APP_Z}`, { method: 'DELETE', headers: authHeaders });
const waitForT2ZGonePassing = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}/deployments/${APP_Z}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 404 }))
  .waitForAssertions(singleBuildPoll);
const deletedPassing = probeBatch([
  ledger('story after the passing delete', 'story', storyDeletePassing, { cell: 'cell4' }),
  { kind: 'ssm', name: 'T2/Z parameter gone', names: [t2ZParamName], exists: false },
  api('GetCell 4', 'GET', `cells/${cellId4}`, 200, { match: { cell: { tenantCount: 1 } } }),
], true);

// DeleteDeployment T1/Z: a-pre ran before the tenant delete script and G
// after it. Cell 4 stays, empty, until step 18. ListHooks shows G alone.
const deleteT1Z = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}/deployments/${APP_Z}`, { method: 'DELETE', headers: authHeaders });
const waitForT1ZGone = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}/deployments/${APP_Z}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 404 }))
  .waitForAssertions(singleBuildPoll);
const deletedT1Z = probeBatch([
  ledger('story after T1/Z is deleted', 'story', storyDeleteT1, { cell: 'cell4' }),
  api('GetCell 4', 'GET', `cells/${cellId4}`, 200, { match: { cell: { status: 'ACTIVE', tenantCount: 0 } } }),
  api('ListHooks G alone', 'GET', 'hooks', 200, { match: { hooks: [{ hookId: HOOK_G }] } }),
], true);

// 17. Hooks on record events (ADR-045, spec §10 step 17). An application
//     hook on a TENANT_* or ACCOUNT_* event is refused. R, a global PRE hook
//     on TENANT_CREATE and TENANT_UPDATE, refuses the tenant name `blocked`
//     (the test hook script fails on it); N, a global POST hook on
//     ACCOUNT_CREATE, runs in step 18; c-post, a third application hook of Z,
//     runs on APPLICATION_UPDATE. These events run one hook build each, so
//     their polls are waiters at the cell and deployment interval
//     (waitForRecord). The hooks record what they saw as step 16's do, plus
//     the record's own variables and the names of the variables they
//     received (record-event checks of the probe).
const HOOK_R = 'r-names';
const HOOK_N = 'n-accounts';
const definitionZWithHook = (hookId: string, events: string[]) => ({
  ...definitionZ,
  hooks: [...appHookDefinitions, { hookId, ...hookDefinition(events, 'POST') }],
});
const definitionZWithCPost = definitionZWithHook('c-post', ['APPLICATION_UPDATE']);
const reasonNamesR = Match.stringLikeRegexp(`(GLOBAL/${HOOK_R}|global hook ${HOOK_R})`);
/** The R-42 variables of a tenant, an application and an account record event, by name (R-42, spec §8.4). */
const recordEventCommonVars = ['ATTEMPT', 'EVENT', 'EXECUTION_ID', 'HOOK_ID', 'HOOK_SCOPE', 'HOOK_SCRIPT', 'OPERATOR_ID', 'PHASE'];
const tenantEventVars = [...recordEventCommonVars, 'TENANT_ID', 'TENANT_NAME'].sort();
const applicationEventPostVars = [...recordEventCommonVars, 'APPLICATION_ID', 'SCRIPT_OUTPUTS'].sort();
const accountEventPostVars = [...recordEventCommonVars, 'ACCOUNT_APPLICATION_IDS', 'ACCOUNT_ID', 'ACCOUNT_OWNER', 'SCRIPT_OUTPUTS'].sort();
/** What a record event's hook recorded, as the probe's record-event check returns it. */
const recordEventOf = (fields: Record<string, unknown>) => ({
  ACCOUNT_APPLICATION_IDS: '',
  ACCOUNT_ID: '',
  ACCOUNT_OWNER: '',
  APPLICATION_ID: '',
  ATTEMPT: '1',
  HOOK_SCOPE: 'GLOBAL',
  SCRIPT_OUTPUTS: '',
  TENANT_ID: '',
  TENANT_NAME: '',
  callerRole: `${fleetName}-global-hook`,
  externalIdSeen: false,
  hasExecutionId: true,
  hasOperatorId: true,
  pairRoleSeen: false,
  ...fields,
});

const recordHooksApi = probeBatch([
  api('PutApplication Z with an application hook on TENANT_CREATE', 'PUT', `applications/${APP_Z}`, 400, {
    body: definitionZWithHook('c-post', ['TENANT_CREATE']),
  }),
  api('PutApplication Z with an application hook on ACCOUNT_UPDATE', 'PUT', `applications/${APP_Z}`, 400, {
    body: definitionZWithHook('c-post', ['ACCOUNT_UPDATE']),
  }),
  api('GetApplication Z unchanged', 'GET', `applications/${APP_Z}`, 200, {
    match: { application: { status: 'ACTIVE', hooks: [{ hookId: 'a-pre' }, { hookId: 'b-post' }] } },
  }),
  api('PutHook R', 'PUT', `hooks/${HOOK_R}`, 200, {
    body: hookDefinition(['TENANT_CREATE', 'TENANT_UPDATE'], 'PRE'),
    match: { hook: { hookId: HOOK_R, phase: 'PRE', events: ['TENANT_CREATE', 'TENANT_UPDATE'], revision: 1 } },
  }),
  api('PutHook N', 'PUT', `hooks/${HOOK_N}`, 200, {
    body: hookDefinition(['ACCOUNT_CREATE'], 'POST'),
    match: { hook: { hookId: HOOK_N, phase: 'POST', events: ['ACCOUNT_CREATE'], revision: 1 } },
  }),
]);

// A tenant named `blocked`: accepted CREATING, R refuses it, it ends
// CREATE_FAILED naming R. Not live, so a deployment for it is a 409 whose
// message carries no retry hint (R-13, R-14; the API's hint is the phrase
// "retry the request"). It is deleted with DeleteTenant; R does not run on
// TENANT_DELETE.
const createTenantBlocked = integ.assertions.httpApiCall(`${apiUrl}tenants`, {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({ name: 'blocked' }),
});
const tenantIdBlocked = createTenantBlocked.getAttString('body.tenant.tenantId');
const waitForBlockedRefused = waitForRecord(`tenants/${tenantIdBlocked}`, 'tenant', {
  status: 'CREATE_FAILED',
  name: 'blocked',
  statusReason: reasonNamesR,
});
const blockedRefused = probeBatch([
  acceptedCreating('CreateTenant blocked', createTenantBlocked, 'tenant'),
  api('CreateDeployment for the CREATE_FAILED tenant', 'POST', `tenants/${tenantIdBlocked}/deployments`, 409, {
    body: { applicationId: APP_Y, adminEmail: 'success+integ-blocked@simulator.amazonses.com' },
    errorType: 'ConflictError',
    match: { message: 're:^(?![\\s\\S]*retry the request)' },
  }),
  api('DeleteTenant blocked', 'DELETE', `tenants/${tenantIdBlocked}`, 202, { match: { tenant: { tenantId: tenantIdBlocked, status: 'DELETING' } } }),
  pollGone('GetTenant blocked deleted', `tenants/${tenantIdBlocked}`),
]);

// T5 passes R and goes ACTIVE, naming R in lastGlobalHooks. Then an update
// that renames it `blocked` is staged, refused by R and ends UPDATE_FAILED
// with the old name live and nothing staged; another name goes through.
const createTenant5 = integ.assertions.httpApiCall(`${apiUrl}tenants`, {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({ name: 'integ-tenant-5' }),
});
const tenantId5 = createTenant5.getAttString('body.tenant.tenantId');
const step17Labels: [string, string][] = [[tenantIdBlocked, 'TB'], [tenantId5, 'T5']];
const waitForT5Active = waitForRecord(`tenants/${tenantId5}`, 'tenant', {
  status: 'ACTIVE',
  name: 'integ-tenant-5',
  lastGlobalHooks: [{ hookId: HOOK_R, phase: 'PRE', revision: 1 }],
});
// R on both creates saw the tenant's R-42 variables (the name being written)
// and nothing of an application, a cell or a parameter (R-42).
const t5Created = probeBatch([
  acceptedCreating('CreateTenant T5', createTenant5, 'tenant'),
  ledger('R on the blocked create', 'record-event', recordEventOf({
    EVENT: 'TENANT_CREATE', HOOK_ID: HOOK_R, PHASE: 'PRE', TENANT_ID: 'TB', TENANT_NAME: 'blocked', received: tenantEventVars,
  }), { hookId: HOOK_R, event: 'TENANT_CREATE', tenant: 'TB' }),
  ledger('R on the T5 create', 'record-event', recordEventOf({
    EVENT: 'TENANT_CREATE', HOOK_ID: HOOK_R, PHASE: 'PRE', TENANT_ID: 'T5', TENANT_NAME: 'integ-tenant-5', received: tenantEventVars,
  }), { hookId: HOOK_R, event: 'TENANT_CREATE', tenant: 'T5' }),
  api('UpdateTenant T5 to blocked', 'PUT', `tenants/${tenantId5}`, 202, {
    body: { name: 'blocked' },
    match: { tenant: { status: 'UPDATING', name: 'integ-tenant-5', pending: { name: 'blocked' } } },
  }),
], false, step17Labels);
const waitForT5UpdateRefused = waitForRecord(`tenants/${tenantId5}`, 'tenant', {
  status: 'UPDATE_FAILED',
  name: 'integ-tenant-5',
  statusReason: reasonNamesR,
});
const t5UpdateRefused = probeBatch([
  api('GetTenant T5 keeps its name', 'GET', `tenants/${tenantId5}`, 200, {
    match: { tenant: { status: 'UPDATE_FAILED', name: 'integ-tenant-5', pending: 'absent:' } },
  }),
  ledger('R on the refused update', 'record-event', recordEventOf({
    EVENT: 'TENANT_UPDATE', HOOK_ID: HOOK_R, PHASE: 'PRE', TENANT_ID: 'T5', TENANT_NAME: 'blocked', received: tenantEventVars,
  }), { hookId: HOOK_R, event: 'TENANT_UPDATE', tenant: 'T5' }),
  api('UpdateTenant T5 renamed', 'PUT', `tenants/${tenantId5}`, 202, {
    body: { name: 'integ-tenant-5-renamed' },
    match: { tenant: { status: 'UPDATING', pending: { name: 'integ-tenant-5-renamed' } } },
  }),
], false, step17Labels);
const waitForT5Renamed = waitForRecord(`tenants/${tenantId5}`, 'tenant', { status: 'ACTIVE', name: 'integ-tenant-5-renamed' });
// T5 is deleted (202, polled to 404). Read after both deletes, R's records
// show one execution per create and update and none for TENANT_DELETE. Then
// Z gains c-post: the put answers 202 UPDATING with the hooks staged, and a
// second put while the event runs is a 409.
const t5Renamed = probeBatch([
  api('GetTenant T5 renamed', 'GET', `tenants/${tenantId5}`, 200, {
    match: { tenant: { status: 'ACTIVE', name: 'integ-tenant-5-renamed', pending: 'absent:' } },
  }),
  api('DeleteTenant T5', 'DELETE', `tenants/${tenantId5}`, 202, { match: { tenant: { tenantId: tenantId5, status: 'DELETING' } } }),
  pollGone('GetTenant T5 deleted', `tenants/${tenantId5}`),
  ledger('R ran on creates and updates only', 'executions', [
    'TENANT_CREATE TB e1', 'TENANT_CREATE T5 e2', 'TENANT_UPDATE T5 e3', 'TENANT_UPDATE T5 e4',
  ], { hookId: HOOK_R }),
  api('PutApplication Z with c-post', 'PUT', `applications/${APP_Z}`, 202, {
    body: definitionZWithCPost,
    match: {
      application: {
        status: 'UPDATING',
        hooks: [{ hookId: 'a-pre' }, { hookId: 'b-post' }],
        pending: { hooks: [{ hookId: 'a-pre' }, { hookId: 'b-post' }, { hookId: 'c-post' }] },
      },
    },
  }),
  api('PutApplication Z while UPDATING', 'PUT', `applications/${APP_Z}`, 409, { body: definitionZWithCPost, errorType: 'ConflictError' }),
], false, step17Labels);
const waitForZUpdated = waitForRecord(`applications/${APP_Z}`, 'application', {
  status: 'ACTIVE',
  hooks: [{ hookId: 'a-pre' }, { hookId: 'b-post' }, { hookId: 'c-post', phase: 'POST', events: ['APPLICATION_UPDATE'] }],
});
// c-post ran under the application hook role with the application's R-42
// variables, SCRIPT_OUTPUTS {} (a commit writes no outputs, R-50), no cell
// and no parameter. Cell 4 keeps the two hooks it was stamped with (P-4).
const zUpdated = probeBatch([
  ledger('c-post record', 'record-event', recordEventOf({
    APPLICATION_ID: APP_Z,
    EVENT: 'APPLICATION_UPDATE',
    HOOK_ID: 'c-post',
    HOOK_SCOPE: 'APPLICATION',
    PHASE: 'POST',
    SCRIPT_OUTPUTS: '{}',
    callerRole: `${fleetName}-app-hook`,
    received: applicationEventPostVars,
  }), { hookId: 'c-post', event: 'APPLICATION_UPDATE' }),
  ledger('c-post executions', 'executions', ['APPLICATION_UPDATE e1'], { hookId: 'c-post' }),
  api('GetCell 4 keeps its stamp', 'GET', `cells/${cellId4}`, 200, {
    match: { cell: { hooks: [{ hookId: 'a-pre' }, { hookId: 'b-post' }] } },
  }),
  api('DeleteHook R', 'DELETE', `hooks/${HOOK_R}`, 200, { match: { hook: { hookId: HOOK_R } } }),
  api('ListHooks G and N', 'GET', 'hooks', 200, { match: { hooks: [{ hookId: HOOK_G }, { hookId: HOOK_N }] } }),
  ledger('strays', 'strays', []),
], true);

// 18. Teardown. Delete the remaining deployments T2/X, T1/Y, T2/Y (G, still
//     registered, records a DEPLOYMENT_DELETE after each delete script) …
const deleteT2X = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}/deployments/${APP_X}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 202, body: { deployment: { status: 'DELETING' } } }));
const waitForT2XGone = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}/deployments/${APP_X}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 404 }))
  .waitForAssertions(singleBuildPoll);
const t2XDeleteParameters = expectBuildParameters('t2x-delete', 'tenant', { PARAM_LOG_LEVEL: 'warn', PARAM_TIER: 'gold' });

const deleteT1Y = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}/deployments/${APP_Y}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 202, body: { deployment: { status: 'DELETING' } } }));
const waitForT1YGone = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}/deployments/${APP_Y}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 404 }))
  .waitForAssertions(singleBuildPoll);
const t1YDeleteParameters = expectBuildParameters('t1y-delete', 'tenant', {});

const deleteT2Y = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}/deployments/${APP_Y}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 202, body: { deployment: { status: 'DELETING' } } }));
const waitForT2YGone = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}/deployments/${APP_Y}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 404 }))
  .waitForAssertions(singleBuildPoll);
const t2YDeleteParameters = expectBuildParameters('t2y-delete', 'tenant', {});

// … every tenant's count is back at 0 and no per-deployment parameter
// remains, in either account …
const getTenant1Zero = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { tenant: { deploymentCount: 0 } } }));
const getTenant2Zero = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { tenant: { deploymentCount: 0 } } }));
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
const cell1DeleteParameters = expectBuildParameters('cell1-delete', 'cell', { PARAM_CELL_SIZE: 'medium' });

const deleteCell2 = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId2}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 202, body: { cell: { status: 'DELETING' } } }));
const waitForCell2Gone = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId2}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 404 }))
  .waitForAssertions(singleBuildPoll);
const cell2DeleteParameters = expectBuildParameters('cell2-delete', 'cell', {});

const deleteCell3 = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId3}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 202, body: { cell: { status: 'DELETING' } } }));
const waitForCell3Gone = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId3}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 404 }))
  .waitForAssertions(singleBuildPoll);
const cell3DeleteParameters = expectBuildParameters('cell3-delete', 'cell', {});

// Cell 4 (Z, in A): empty since step 16; G records its CELL_DELETE too.
// (c-post, N and the record events leave no record under a cell.)
const deleteCell4 = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId4}`, { method: 'DELETE', headers: authHeaders });
const waitForCell4Gone = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId4}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 404 }))
  .waitForAssertions(singleBuildPoll);
// Cell 4's last event is its delete: the script, then G's CELL_DELETE. G
// recorded a CELL_DELETE for every cell, in the order the cells were deleted.
// This run's tenant and cell namespaces are empty in A (a check looks at this
// run's ids only: another run may share the account and Region, spec §10), and
// in B just below.
const cellsDeleted = probeBatch([
  ledger('story after the cell deletes', 'story', storyCellDeleted, { cell: 'cell4' }),
  ledger(
    'G cell deletes',
    'cell-deletes',
    ['cell1', 'cell2', 'cell3', 'cell4'].map((cell) => `hook GLOBAL/${HOOK_G} CELL_DELETE POST ${cell} a1`),
  ),
  {
    kind: 'ssm',
    name: 'namespaces empty in A',
    paths: [tenantId1, tenantId2].map((id) => `/application-plane/tenants/${id}`)
      .concat([cellId1, cellId2, cellId3, cellId4].map((id) => `/application-plane/cells/${id}`)),
    count: 0,
  },
], true);
const probeNamespacesEmptyB = probeB('ProbeNamespacesEmptyB', {
  paths: [tenantId1, tenantId2].map((id) => `/application-plane/tenants/${id}`)
    .concat([cellId1, cellId2, cellId3, cellId4].map((id) => `/application-plane/cells/${id}`)),
}).expect(ExpectedResult.objectLike({ Payload: '0' }));

// … both accounts and both applications are empty again, the fleet has no
// cells, and the cell delete scripts cleaned their namespaces in both
// accounts …
const getAccountAEmpty = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountA}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { account: { cellCount: 0, maxCells: 3 } } }));
const getAccountBEmpty = integ.assertions
  .httpApiCall(`${apiUrl}accounts/${accountB}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { account: { cellCount: 0, maxCells: 1 } } }));
// Through the step probe, which returns only its verdict: three application
// summaries, with status, lastGlobalHooks and operationId since ADR-045,
// exceed the 4 KB custom resource response ("Response object is too long").
const listApplicationsEmptyCounts = probeBatch([
  api('ListApplications all empty', 'GET', 'applications', 200, {
    match: {
      applications: [{ applicationId: APP_X, cellCount: 0 }, { applicationId: APP_Y, cellCount: 0 }, { applicationId: APP_Z, cellCount: 0 }],
    },
  }),
]);
const listCellsEmpty = integ.assertions
  .httpApiCall(`${apiUrl}cells`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { cells: [] } }));

// … G goes once every cell it was to see is gone; the tenants and both
// accounts are deleted (empty-only, 202, polled to 404). B is then
// registered again, so N runs on its ACCOUNT_CREATE (a POST hook: the account
// is ACTIVE only after it ran) …
const recordsDeleted = probeBatch([
  api('DeleteHook G', 'DELETE', `hooks/${HOOK_G}`, 200, { match: { hook: { hookId: HOOK_G } } }),
  api('DeleteTenant T1', 'DELETE', `tenants/${tenantId1}`, 202, { match: { tenant: { tenantId: tenantId1, status: 'DELETING' } } }),
  api('DeleteTenant T2', 'DELETE', `tenants/${tenantId2}`, 202, { match: { tenant: { tenantId: tenantId2, status: 'DELETING' } } }),
  api('DeleteAccount A', 'DELETE', `accounts/${accountA}`, 202, { match: { account: { accountId: accountA, status: 'DELETING' } } }),
  api('DeleteAccount B', 'DELETE', `accounts/${accountB}`, 202, { match: { account: { accountId: accountB, status: 'DELETING' } } }),
  pollGone('GetTenant T1 deleted', `tenants/${tenantId1}`),
  pollGone('GetTenant T2 deleted', `tenants/${tenantId2}`),
  pollGone('GetAccount A deleted', `accounts/${accountA}`),
  pollGone('GetAccount B deleted', `accounts/${accountB}`),
  api('PutAccount B again', 'PUT', `accounts/${accountB}`, 202, {
    body: { owner: 'TENANT', maxCells: 1, externalId: accountBExternalId, applicationIds: [APP_Y] },
    match: { account: { accountId: accountB, status: 'CREATING', cellCount: 0 } },
  }),
]);
const waitForBRegisteredAgain = waitForRecord(`accounts/${accountB}`, 'account', {
  status: 'ACTIVE',
  lastGlobalHooks: [{ hookId: HOOK_N, phase: 'POST', revision: 1 }],
});
// … N saw B's id, owner and admitted applications, SCRIPT_OUTPUTS {}, and no
// variable holding the external id or naming a pair role (R-42). B is
// deleted again, then N and the applications; the lists are empty; and last,
// the hook ledger, test state in A that no stack owns, is deleted (the probe
// reports what is left under this run's path).
const finalBatch = probeBatch([
  ledger('N record', 'record-event', recordEventOf({
    ACCOUNT_APPLICATION_IDS: APP_Y,
    ACCOUNT_ID: 'B',
    ACCOUNT_OWNER: 'TENANT',
    EVENT: 'ACCOUNT_CREATE',
    HOOK_ID: HOOK_N,
    PHASE: 'POST',
    SCRIPT_OUTPUTS: '{}',
    received: accountEventPostVars,
  }), { hookId: HOOK_N, event: 'ACCOUNT_CREATE' }),
  ledger('N ran once', 'executions', ['ACCOUNT_CREATE e1'], { hookId: HOOK_N }),
  api('DeleteAccount B again', 'DELETE', `accounts/${accountB}`, 202, { match: { account: { accountId: accountB, status: 'DELETING' } } }),
  pollGone('GetAccount B deleted again', `accounts/${accountB}`),
  api('DeleteHook N', 'DELETE', `hooks/${HOOK_N}`, 200, { match: { hook: { hookId: HOOK_N } } }),
  ...[APP_X, APP_Y, APP_Z].map((applicationId) => api(`DeleteApplication ${applicationId}`, 'DELETE', `applications/${applicationId}`, 202, {
    match: { application: { applicationId, status: 'DELETING' } },
  })),
  ...[APP_X, APP_Y, APP_Z].map((applicationId) => pollGone(`GetApplication ${applicationId} deleted`, `applications/${applicationId}`)),
  api('ListHooks empty', 'GET', 'hooks', 200, { match: { hooks: [] } }),
  api('ListTenants empty', 'GET', 'tenants', 200, { match: { tenants: [] } }),
  api('ListAccounts empty', 'GET', 'accounts', 200, { match: { accounts: [] } }),
  api('ListApplications empty', 'GET', 'applications', 200, { match: { applications: [] } }),
  ledger('strays', 'strays', []),
  ledger('ledger cleanup', 'cleanup', { remaining: 0 }),
], true);

// Sequence the lifecycle strictly (references alone order most of it, but
// the reads/guards must not race the polls, and the in-flight 409 must fire
// while T2/Y is still CREATING).
createUser
  .next(randomPassword)
  .next(setPassword)
  .next(authenticate)
  .next(readerIdentity.calls[0])
  .next(readerIdentity.calls[1])
  .next(readerIdentity.calls[2])
  .next(unlistedIdentity.calls[0])
  .next(unlistedIdentity.calls[1])
  .next(unlistedIdentity.calls[2])
  // applications (§10 step 2)
  .next(applications)
  // accounts (step 3)
  .next(accounts)
  // tenants run no build (step 4)
  .next(createTenant1)
  .next(createTenant2)
  .next(createTenant3)
  .next(tenantsCreated)
  // reader grant (step 1, R-36), with step 4's tenants in place
  // the reader's first call is a write, so its cached policy is filled by
  // a POST: its reads must still pass (R-36, grant-only policy)
  .next(readerAndUnlisted)
  .next(machineListTenants)
  .next(machineGetTenant1)
  .next(machineCreateTenant)
  .next(unlistedMachineListTenants)
  .next(machineOtherScopeListTenants)
  .next(afterReader)
  .next(tenant3Lifecycle)
  // T1/X → cell 1 in A (step 5)
  .next(createT1XMissingRequired)
  .next(createT1XUndeclared)
  .next(createT1X)
  .next(waitForT1XActive)
  .next(getT1X)
  .next(getCell1)
  .next(getAccountAOne)
  .next(readerReads)
  .next(getApplicationXOne)
  .next(getTenant1One)
  .next(checkCellParam)
  .next(checkT1XParam)
  .next(t1XCreateParameters)
  .next(cell1CreateParameters)
  // T1/Y → cell 2 in A; one tenant, two applications (step 6)
  .next(createT1Y)
  .next(waitForT1YActive)
  .next(t1YCreateParameters)
  .next(cell2CreateParameters)
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
  .next(reuseTokenOtherValue)
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
  .next(t2YCreateParameters)
  .next(cell3CreateParameters)
  .next(getCell3)
  .next(probeCell3InB)
  .next(probeT2YInB)
  .next(checkCell3NotInA)
  .next(getAccountBFull)
  .next(getApplicationYTwo)
  // B full (step 11)
  .next(createTenant4)
  .next(accountFull)
  // reads (step 12)
  .next(listCellsThree)
  .next(listCellsInA)
  .next(listCellsUnknownAccount)
  .next(listCellsTwoFilters)
  .next(listDeploymentsByCell1)
  .next(listDeploymentsOfY)
  .next(listDeploymentsUnknownCell)
  .next(listDeploymentsTwoFilters)
  .next(tenant1AndYReplaced)
  // re-apply in A and in B, parameter merges (step 13)
  .next(updateT1X)
  .next(waitForT1XUpdated)
  .next(t1XUpdateParameters)
  .next(updateT1XLogLevel)
  .next(waitForT1XLogLevel)
  .next(t1XDebugParameters)
  .next(updateT1XRefusals[0])
  .next(updateT1XRefusals[1])
  .next(updateT1XRefusals[2])
  .next(updateT1XRefusals[3])
  .next(getT1XAfterRefusals)
  .next(updateCell3)
  .next(waitForCell3Updated)
  .next(cell3UpdateParameters)
  .next(updateCell1Large)
  .next(waitForCell1Large)
  .next(cell1LargeParameters)
  .next(getCell1Large)
  .next(updateCell1Refusals[0])
  .next(updateCell1Refusals[1])
  .next(updateCell1Remove)
  .next(waitForCell1Removed)
  .next(cell1RemovedParameters)
  // declarations change under live records (step 14)
  .next(declarationsKept)
  .next(updateT1XDropLogLevel)
  .next(waitForT1XDropLogLevel)
  .next(t1XWarnParameters)
  .next(updateCell1Medium)
  .next(waitForCell1Medium)
  .next(cell1MediumParameters)
  .next(tierRequired)
  // guards, delete T1/X, reuse cell 1 for T2/X (step 15)
  .next(deleteCellOccupied)
  .next(deleteT1X)
  .next(waitForT1XGone)
  .next(t1XDeleteParameters)
  .next(getCell1SlotFreed)
  .next(getAccountAStillFull)
  .next(getApplicationXStillOne)
  .next(getTenant1OneAgain)
  .next(checkT1XParamGone)
  .next(createT2X)
  .next(waitForT2XActive)
  .next(t2XCreateParameters)
  // hooks (step 16): the API, then Z through create, update, a gate, a
  // failing delete hook, a failing post hook and the deletes
  .next(hooksApi)
  .next(createT1Z)
  .next(waitForT1ZActive)
  .next(t1ZCreated)
  .next(updateT1Z)
  .next(waitForT1ZUpdated)
  .next(updateCell4)
  .next(waitForCell4Updated)
  .next(gateRegistered)
  .next(createT2ZGated)
  .next(waitForT2ZGated)
  .next(gated)
  .next(deleteT2ZFailing)
  .next(waitForT2ZGoneFailing)
  .next(deletedFailing)
  .next(createT2ZPostFail)
  .next(waitForT2ZPostFailed)
  .next(postFailed)
  .next(deleteT2ZPassing)
  .next(waitForT2ZGonePassing)
  .next(deletedPassing)
  .next(deleteT1Z)
  .next(waitForT1ZGone)
  .next(deletedT1Z)
  // hooks on record events (step 17)
  .next(recordHooksApi)
  .next(createTenantBlocked)
  .next(waitForBlockedRefused)
  .next(blockedRefused)
  .next(createTenant5)
  .next(waitForT5Active)
  .next(t5Created)
  .next(waitForT5UpdateRefused)
  .next(t5UpdateRefused)
  .next(waitForT5Renamed)
  .next(t5Renamed)
  .next(waitForZUpdated)
  .next(zUpdated)
  // teardown (step 18)
  .next(deleteT2X)
  .next(waitForT2XGone)
  .next(t2XDeleteParameters)
  .next(deleteT1Y)
  .next(waitForT1YGone)
  .next(t1YDeleteParameters)
  .next(deleteT2Y)
  .next(waitForT2YGone)
  .next(t2YDeleteParameters)
  .next(getTenant1Zero)
  .next(getTenant2Zero)
  .next(deleteCell1)
  .next(waitForCell1Gone)
  .next(cell1DeleteParameters)
  .next(deleteCell2)
  .next(waitForCell2Gone)
  .next(cell2DeleteParameters)
  .next(deleteCell3)
  .next(waitForCell3Gone)
  .next(cell3DeleteParameters)
  .next(deleteCell4)
  .next(waitForCell4Gone)
  .next(cellsDeleted)
  .next(probeNamespacesEmptyB)
  .next(getAccountAEmpty)
  .next(getAccountBEmpty)
  .next(listApplicationsEmptyCounts)
  .next(listCellsEmpty)
  .next(recordsDeleted)
  .next(waitForBRegisteredAgain)
  .next(finalBatch);

// The assertion provider adds one statement to its role's inline policy for
// every assertion call, duplicates included, and the scenario now has
// enough calls to pass IAM's 10,240-byte inline policy limit (the first
// parameter-step run failed with ServiceLimitExceeded on that role).
// Dropping exact duplicates keeps every grant; a statement's JSON with its
// tokens unresolved is the same string only when it names the same
// resources, so nothing is merged that differs.
dedupeAssertionProviderPolicies(app);

/**
 * Removes exact duplicate statements from every integ-tests assertion
 * provider's role policy (test-only; the provider's own construct keeps its
 * statements in a `policies` array it renders lazily at synth).
 */
function dedupeAssertionProviderPolicies(root: IConstruct): void {
  for (const construct of root.node.findAll()) {
    const policies = (construct as unknown as { policies?: unknown }).policies;
    if (!construct.node.id.startsWith('SingletonFunction') || !Array.isArray(policies)) {
      continue;
    }
    const seen = new Set<string>();
    const unique = policies.filter((statement) => {
      const key = JSON.stringify(statement);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
    policies.splice(0, policies.length, ...unique);
  }
}

/** Reads a required environment variable or fails synth with the reason it is needed. */
function requireEnv(name: string, purpose: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} must be set: ${purpose}`);
  }
  return value;
}
