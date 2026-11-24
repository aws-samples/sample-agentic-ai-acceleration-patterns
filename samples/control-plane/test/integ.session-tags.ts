// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as path from 'path';
import { ExpectedResult, IntegTest } from '@aws-cdk/integ-tests-alpha';
import { App, ArnFormat, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { ApplicationLogLevel } from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { RegionInfo } from 'aws-cdk-lib/region-info';
import { CellAccountStack } from '../src/cell-account/cell-account.cdk';
import { ProvisioningRoleKind, provisioningRoleArn } from '../src/shared/fleet';
import { suppressTemplateScanners } from '../src/shared/nag';
import { TenantStack } from '../src/tenant/tenant.cdk';
import { INLINE_BUILDSPECS } from '../src/tenant/tenant.sfn';

/**
 * Session tag integration test (ADR-0051): real IAM across TWO accounts, on
 * a small fleet of its own.
 *
 * It deploys the stack under test in account A (the control plane's build
 * roles and provisioning projects) and the account role pair in account B
 * (`CP_INTEG_ACCOUNT_B`, CDK-bootstrapped to trust A), behind an external id.
 * It registers nothing through the API: each check starts a build in one of
 * the stack's own provisioning projects, so it runs as that project's real
 * build role, with the source and environment overrides the workflow passes.
 *
 * - Two builds use a test buildspec that does not assume the pair, so they
 *   hold the build role's own credentials, and ask B's pair for the
 *   AssumeRole calls a correct build never makes (no tags, tags not
 *   transitive, another key, a missing key, no external id), then for the
 *   correct one (the positive control). The build role's own grant carries
 *   the same TagSession conditions as B's trust, so a request with the
 *   wrong keys is refused by both; the untagged request and the one without
 *   the external id are refused by B's trust alone. The positive builds
 *   below run through both, as production builds do.
 * - Three builds use the sample's own inline buildspecs
 *   (`INLINE_BUILDSPECS`), which assume the pair with the session tags, and
 *   run a test script as the tagged session: two cell builds (cells 1 and
 *   2, so two cells in one account) and one tenant build. The scripts record
 *   what each session may do in its own and the other cell's and tenant's
 *   SSM namespaces, and in two test roles in B it chains into: one whose
 *   caller holds only `sts:AssumeRole` on it (refused: chaining with the
 *   inherited tag needs `sts:TagSession` on the caller too), and one whose
 *   caller may also tag (transitivity through a policy that names
 *   `${aws:PrincipalTag/CellId}`, and a refused tag override).
 *
 * Each build exports its results as `SCRIPT_OUTPUTS`; a run probe in A starts
 * the build once (found again by a label variable) and returns its status and
 * results until it ends. The test compares them with what ADR-0051 claims.
 *
 * Not covered here: the workflow's own StartBuild (its environment mapping is
 * pinned by unit tests in test/main.test.ts), the home account (R-41 deny),
 * and a `cdk deploy` through the CloudFormation execution role
 * (integration-test.md, "Session tags").
 */

const accountA = requireEnv('CDK_DEFAULT_ACCOUNT', 'the account the test runs in (the integ task resolves it with sts get-caller-identity)');
const accountB = requireEnv('CP_INTEG_ACCOUNT_B', 'the second, tenant-owned test account (12 digits), CDK-bootstrapped to trust this one');
const region = process.env.AWS_REGION ?? requireEnv('CDK_DEFAULT_REGION', 'the single Region to test in (the integ task sets AWS_REGION)');
if (!/^\d{12}$/.test(accountB) || accountB === accountA) {
  throw new Error('CP_INTEG_ACCOUNT_B must be a 12-digit AWS account id different from the account the test runs in');
}
const runId = requireEnv('CP_INTEG_RUN_ID', 'this run\'s id, 1 to 23 characters of [a-z0-9] without aws, amazon or cognito (the integ task generates one)');
if (!/^[a-z0-9]{1,23}$/.test(runId) || /aws|amazon|cognito/.test(runId)) {
  throw new Error('CP_INTEG_RUN_ID must match [a-z0-9]{1,23} and must not contain aws, amazon or cognito');
}
const fleetName = `cp-integ-${runId}`;
const partition = RegionInfo.get(region).partition ?? 'aws';
const externalId = 'control-plane-integ-handshake';

/** Ids the builds tag their sessions with (the workflow would resolve them). */
const CELL_1 = `c1${runId}`;
const CELL_2 = `c2${runId}`;
const TENANT_1 = `t1${runId}`;
const TENANT_2 = `t2${runId}`;
const APP = `p-${runId}`;
const OTHER_APP = `q-${runId}`;

const chainRoleName = `${fleetName}-chain`;
const chainTaggedRoleName = `${fleetName}-chain-tagged`;
const chainPolicyName = `${fleetName}-chain-assume`;
const chainArn = (name: string) => `arn:${partition}:iam::${accountB}:role/${name}`;
const chainPolicyArn = `arn:${partition}:iam::${accountB}:policy/${chainPolicyName}`;

const app = new App();

// --- Setup (A): a vendor IdP the stack needs at synth, the test scripts, the run probe
const setup = new Stack(app, `${fleetName}-setup`, { env: { account: accountA, region } });
// No user signs in: the stack requires an issuer and an audience, and this
// test calls no API operation.
const vendorIdp = new cognito.UserPool(setup, 'VendorIdp', { selfSignUpEnabled: false, removalPolicy: RemovalPolicy.DESTROY });
const idpClient = vendorIdp.addClient('IntegClient', { authFlows: {}, generateSecret: false });

const scriptsBucket = new s3.Bucket(setup, 'ProbeScripts', {
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  encryption: s3.BucketEncryption.S3_MANAGED,
  enforceSSL: true,
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});
suppressTemplateScanners(scriptsBucket, {
  cfnNag: [{ id: 'W35', reason: 'Ephemeral integ-test script source, auto-deleted on teardown.' }],
  checkov: [
    { id: 'CKV_AWS_18', comment: 'Ephemeral integ-test script source, auto-deleted on teardown.' },
    { id: 'CKV_AWS_21', comment: 'Ephemeral integ-test script source, auto-deleted on teardown.' },
  ],
});
new s3deploy.BucketDeployment(setup, 'DeployProbeScripts', {
  destinationBucket: scriptsBucket,
  destinationKeyPrefix: 'scripts/session-tags',
  sources: [s3deploy.Source.asset(path.join(__dirname, 'integ-scripts/session-tags'))],
});

// Starts a build once, found again by its PROBE_LABEL variable, and returns
// `{ status }` while it runs, then `{ status, results }`: the build's
// SCRIPT_OUTPUTS without the `_code` keys, keys sorted. The full outputs
// (with the error codes) go to this function's log.
const runProbe = new lambda.Function(setup, 'RunProbe', {
  runtime: lambda.Runtime.NODEJS_24_X,
  handler: 'index.handler',
  timeout: Duration.seconds(60),
  code: lambda.Code.fromInline(`
    const { CodeBuildClient, StartBuildCommand, ListBuildsForProjectCommand, BatchGetBuildsCommand } = require('@aws-sdk/client-codebuild');
    const codebuild = new CodeBuildClient({});
    exports.handler = async (event) => {
      const listed = await codebuild.send(new ListBuildsForProjectCommand({ projectName: event.projectName, sortOrder: 'DESCENDING' }));
      const ids = (listed.ids || []).slice(0, 100);
      const builds = ids.length ? (await codebuild.send(new BatchGetBuildsCommand({ ids }))).builds || [] : [];
      const build = builds.find((b) => (b.environment?.environmentVariables || []).some((v) => v.name === 'PROBE_LABEL' && v.value === event.label));
      if (!build) {
        const environment = { ...event.environment, PROBE_LABEL: event.label };
        await codebuild.send(new StartBuildCommand({
          projectName: event.projectName,
          sourceTypeOverride: 'S3',
          sourceLocationOverride: event.sourceLocation,
          buildspecOverride: event.buildspec,
          environmentVariablesOverride: Object.entries(environment).map(([name, value]) => ({ name, value, type: 'PLAINTEXT' })),
        }));
        return { status: 'STARTED' };
      }
      if (build.buildStatus === 'IN_PROGRESS') {
        return { status: 'IN_PROGRESS' };
      }
      if (build.buildStatus !== 'SUCCEEDED') {
        // Fail the assertion on this poll, with the build id, instead of
        // polling a finished build until the total timeout.
        throw new Error(event.label + ': build ' + build.id + ' ended ' + build.buildStatus);
      }
      const raw = (build.exportedEnvironmentVariables || []).find((v) => v.name === 'SCRIPT_OUTPUTS')?.value;
      let outputs;
      try { outputs = JSON.parse(raw || '{}'); } catch { outputs = { unparsable: String(raw) }; }
      console.log(JSON.stringify({ label: event.label, buildId: build.id, status: build.buildStatus, outputs }));
      const results = Object.fromEntries(Object.keys(outputs).filter((k) => !k.endsWith('_code')).sort().map((k) => [k, outputs[k]]));
      return { status: build.buildStatus, results };
    };
  `),
});
runProbe.addToRolePolicy(new iam.PolicyStatement({
  actions: ['codebuild:StartBuild', 'codebuild:ListBuildsForProject', 'codebuild:BatchGetBuilds'],
  resources: [setup.formatArn({ service: 'codebuild', resource: 'project', resourceName: `${fleetName}-*` })],
}));

// --- Account B: the role pair, plus two test roles the cell session chains into
const accountBStack = new CellAccountStack(app, `${fleetName}-account-b`, {
  controlPlaneAccountId: accountA,
  fleetName,
  externalId,
  // ADR-0047: the owner's policy on the cell role lets it chain into the test roles.
  cellBuildManagedPolicyArns: [chainPolicyArn],
  env: { account: accountB, region },
});
const cellRoleArn = provisioningRoleArn(partition, accountB, fleetName, 'cell');
const chainLedger = (variable: string) => accountBStack.formatArn({
  service: 'ssm',
  resource: 'parameter',
  resourceName: `cp-integ/${fleetName}/chain/${variable}`,
  arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
});
for (const [id, roleName] of [['ChainRole', chainRoleName], ['ChainTaggedRole', chainTaggedRoleName]]) {
  // A chained role's trust must allow sts:TagSession for the inherited
  // transitive tags (as the CDK bootstrap roles' trusts do).
  const role = new iam.Role(accountBStack, id, {
    roleName,
    description: 'control-plane integ test only: a role the cell session chains into (ADR-0051)',
    assumedBy: new iam.SessionTagsPrincipal(new iam.PrincipalWithConditions(new iam.AccountPrincipal(accountB), {
      ArnEquals: { 'aws:PrincipalArn': cellRoleArn },
    })),
  });
  // Writes only under the session's own CellId: a write succeeds only if
  // the tag reached this hop with the cell's value.
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['ssm:PutParameter', 'ssm:DeleteParameter'],
    resources: [chainLedger('${aws:PrincipalTag/CellId}')],
  }));
}
const chainPolicy = new iam.ManagedPolicy(accountBStack, 'ChainAssumePolicy', {
  managedPolicyName: chainPolicyName,
  description: 'control-plane integ test only: the cell role may chain into the two test roles',
  statements: [
    new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [chainArn(chainRoleName), chainArn(chainTaggedRoleName)] }),
    // The inherited key only, as stress's cell-build-policy grants it.
    new iam.PolicyStatement({
      actions: ['sts:TagSession'],
      resources: [chainArn(chainTaggedRoleName)],
      conditions: { 'ForAllValues:StringEquals': { 'aws:TagKeys': ['CellId'] } },
    }),
  ],
});
accountBStack.roles.cellRole.node.addDependency(chainPolicy);

// --- Stack under test (A)
const stack = new TenantStack(app, fleetName, {
  env: { account: accountA, region },
  fleetName,
  vendorIdpIssuerUrl: vendorIdp.userPoolProviderUrl,
  vendorIdpAudience: idpClient.userPoolClientId,
});
scriptsBucket.grantRead(stack.provisioning.cellProject);
scriptsBucket.grantRead(stack.provisioning.tenantProject);

const assertionStack = new Stack(app, `${fleetName}-assert`, { env: { account: accountA, region } });
const integ = new IntegTest(app, `ControlPlaneSessionTags${runId}`, {
  testCases: [setup, accountBStack, stack],
  assertionStack,
  providerLogLevel: ApplicationLogLevel.INFO,
  cdkCommandOptions: { destroy: { args: { force: true } } },
});

/** The buildspec of the two negative builds: the script runs with the build role's own credentials. */
const NEGATIVES_BUILDSPEC = [
  'version: 0.2',
  'env:',
  '  shell: bash',
  '  exported-variables:',
  '    - SCRIPT_OUTPUTS',
  'phases:',
  '  build:',
  '    commands:',
  '      - |',
  '        OUTPUTS_FILE=$(mktemp)',
  '        export OUTPUTS_FILE',
  '        bash session-tags/negatives.sh',
  '        SCRIPT_OUTPUTS=$(jq -c . "$OUTPUTS_FILE")',
  '        export SCRIPT_OUTPUTS',
].join('\n');

const buildPoll = { totalTimeout: Duration.minutes(15), interval: Duration.seconds(20) };

/** One build in a provisioning project, expected to succeed with `results`. */
function expectBuild(
  label: string,
  kind: ProvisioningRoleKind,
  buildspec: string,
  environment: Record<string, string>,
  results: Record<string, string>,
) {
  const projectName = (kind === 'cell' ? stack.provisioning.cellProject : stack.provisioning.tenantProject).projectName;
  const sorted = Object.fromEntries(Object.entries(results).sort(([a], [b]) => (a < b ? -1 : 1)));
  integ.assertions
    .invokeFunction({
      functionName: runProbe.functionName,
      payload: JSON.stringify({
        label: `${runId}-${label}`,
        projectName,
        sourceLocation: `${scriptsBucket.bucketName}/scripts/`,
        buildspec,
        environment: {
          PROVISIONING_ROLE_ARN: provisioningRoleArn(partition, accountB, fleetName, kind),
          PROVISIONING_EXTERNAL_ID: externalId,
          OPERATOR_SESSION_NAME: 'integ-session-tags',
          CELL_ACCOUNT_ID: accountB,
          OPERATION: 'create',
          ...environment,
        },
      }),
    })
    .expect(ExpectedResult.objectLike({ Payload: JSON.stringify({ status: 'SUCCEEDED', results: sorted }) }))
    .waitForAssertions(buildPoll);
}

const allowed = 'allowed';
const refused = 'refused';

// The build role's grant and the pair's trust refuse every request a
// correct cell build never makes, and admit the correct one. Only
// `untagged` and `noExternalId` isolate the trust: the other refusals
// come from the trust and the build role's own TagSession grant together,
// which carry the same conditions. The trust's tag conditions alone are
// pinned by the evaluator in test/shared/session-tags.test.ts.
expectBuild('cell-negatives', 'cell', NEGATIVES_BUILDSPEC, { KIND: 'cell', CELL_ID: CELL_1, TENANT_ID: TENANT_1, APPLICATION_ID: APP }, {
  untagged: refused,
  notTransitive: refused,
  extraKey: refused,
  extraKeyNotTransitive: refused,
  tenantTags: refused,
  noExternalId: refused,
  tagged: allowed,
});
// The same for a tenant build. With all three tags present, one transitive
// key is enough (the trust allows a subset of the three; the buildspec makes
// all three transitive).
expectBuild('tenant-negatives', 'tenant', NEGATIVES_BUILDSPEC, { KIND: 'tenant', CELL_ID: CELL_1, TENANT_ID: TENANT_1, APPLICATION_ID: APP }, {
  untagged: refused,
  cellTagOnly: refused,
  missingTenantId: refused,
  notTransitive: refused,
  cellTransitiveOnly: allowed,
  noExternalId: refused,
  tagged: allowed,
});

// Two cells in one account: each tagged cell session reaches its own cell
// namespace only, chains with its tag, and cannot replace the tag.
const cellResults = {
  ownCellWrite: allowed,
  ownCellRead: allowed,
  peerCellWrite: refused,
  peerCellRead: refused,
  tenantWrite: refused,
  sharedRead: allowed,
  // A chained AssumeRole that inherits the tag needs sts:TagSession on the
  // caller as well as in the next role's trust.
  chainAssume: refused,
  chainTaggedAssume: allowed,
  chainOwnWrite: allowed,
  chainPeerWrite: refused,
  chainOwnDelete: allowed,
  // STS refuses to set an inherited transitive key again.
  chainOverride: 'error:InvalidParameterValue',
  ownCellDelete: allowed,
};
const chainEnvironment = {
  FLEET_NAME: fleetName,
  APPLICATION_ID: APP,
  PEER_TENANT_ID: TENANT_2,
  CHAIN_ROLE_ARN: chainArn(chainRoleName),
  CHAIN_TAGGED_ROLE_ARN: chainArn(chainTaggedRoleName),
  SCRIPT_PATH: 'session-tags/cell-probe.sh',
};
expectBuild('cell-1', 'cell', INLINE_BUILDSPECS.cell, { ...chainEnvironment, CELL_ID: CELL_1, PEER_CELL_ID: CELL_2 }, cellResults);
expectBuild('cell-2', 'cell', INLINE_BUILDSPECS.cell, { ...chainEnvironment, CELL_ID: CELL_2, PEER_CELL_ID: CELL_1 }, cellResults);

// A tagged tenant session writes its own deployment namespace only and reads
// its own cell only.
expectBuild('tenant-1', 'tenant', INLINE_BUILDSPECS.tenant, {
  CELL_ID: CELL_1,
  TENANT_ID: TENANT_1,
  APPLICATION_ID: APP,
  PEER_CELL_ID: CELL_2,
  PEER_TENANT_ID: TENANT_2,
  PEER_APPLICATION_ID: OTHER_APP,
  SCRIPT_PATH: 'session-tags/tenant-probe.sh',
}, {
  ownDeploymentWrite: allowed,
  ownStateWrite: allowed,
  otherApplicationWrite: refused,
  otherTenantWrite: refused,
  ownCellRead: allowed,
  peerCellRead: refused,
  ownCellWrite: refused,
  ownStateDelete: allowed,
  ownDeploymentDelete: allowed,
});

/** Reads a required environment variable or fails synth with the reason it is needed. */
function requireEnv(name: string, purpose: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} must be set: ${purpose}`);
  }
  return value;
}
