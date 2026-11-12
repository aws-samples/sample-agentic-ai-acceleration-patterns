// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { ArnFormat, Duration, RemovalPolicy, Stack, Validations } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import { buildRoleName, provisioningRoleArn, ProvisioningRoleKind } from '../shared/fleet';
import { nagFindingResource, acknowledgeGranularFinding, suppressTemplateScanners } from '../shared/nag';

export interface ProvisioningWorkflowProps {
  /** The control plane table (accounts + cells + tenants; terminal state is written directly to it). */
  readonly table: dynamodb.ITable;
  /**
   * Names the two build roles (`<fleet>-cell-build`, `<fleet>-tenant-build`)
   * and the provisioning role pair they may assume in any registered
   * account (`<fleet>-cell-provisioning`, `<fleet>-tenant-provisioning`),
   * spec §3.3 / §6.4, ADR-025. Already validated by the stack.
   */
  readonly fleetName: string;
}

/**
 * Catchable per-build budget (task-level TimeoutSeconds on each StartBuild
 * task). A timeout surfaces as States.Timeout and is caught like a build
 * failure (architecture.md §7).
 */
const BUILD_TIMEOUT = Duration.hours(1);

/**
 * Execution timeout: greater than the sum of both build-task budgets plus
 * terminal-write recovery margin (§7). It is a final safety net, not the
 * normal timeout path — that is the catchable task-level timeout above.
 */
const EXECUTION_TIMEOUT = Duration.hours(3);

/**
 * M17 (threat T16): each CreateDeployment/UpdateDeployment/UpdateCell/DeleteCell
 * fans out to CodeBuild, so a leaked operator token or a runaway client is
 * a cost/concurrency amplification vector. Capping concurrent builds per
 * project bounds the parallel spend; excess StartBuild requests queue
 * rather than fan out. Sample-appropriate value — tune for real fleets.
 */
const CONCURRENT_BUILD_LIMIT = 5;

/**
 * The inline buildspec — every execution overrides source and runs its
 * resolved script. Before the script starts, the build assumes the hosting
 * account's provisioning role (ADR-025, spec §6.1 "Credentials"): the role
 * ARN, the account's external id (empty when none), and the operator
 * session name (M23) arrive as environment variables resolved by the
 * service; the credentials are read into shell variables and exported as
 * the three standard AWS variables — never written to CodeBuild environment
 * variables, the execution input, or the log (M21, T24). The container
 * credential variables that would let the script fetch the BUILD role's own
 * credentials (and with them assume the pair in any registered account) are
 * removed from the script's environment (T29, M24); the external id is
 * removed too, which keeps it out of the script's environment though not out
 * of the build's (the agent process still holds both). An AssumeRole that
 * returns nothing fails closed before the script runs. Role chaining caps the
 * credentials at one hour, equal to BUILD_TIMEOUT (N-7). A refused AssumeRole
 * fails the build like any script failure and lands in `*_FAILED`.
 */
const INLINE_BUILDSPEC = [
  'version: 0.2',
  'env:',
  '  shell: bash',
  'phases:',
  '  build:',
  '    commands:',
  // Brace-less `$VAR` expansions throughout: the buildspec is embedded in the
  // state machine DefinitionString, where `${...}` reads as an Fn::Sub
  // placeholder to CloudFormation's template validator.
  '      - |',
  '        set -euo pipefail',
  '        set --',
  '        if [ -n "$PROVISIONING_EXTERNAL_ID" ]; then set -- --external-id "$PROVISIONING_EXTERNAL_ID"; fi',
  '        CREDENTIALS=$(aws sts assume-role --role-arn "$PROVISIONING_ROLE_ARN" --role-session-name "$OPERATOR_SESSION_NAME" "$@" --query "Credentials.[AccessKeyId,SecretAccessKey,SessionToken]" --output text)',
  '        read -r AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN <<< "$CREDENTIALS"',
  '        if [ -z "$AWS_SESSION_TOKEN" ]; then',
  '          echo "AssumeRole returned no credentials"',
  '          exit 1',
  '        fi',
  '        export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN',
  '        unset CREDENTIALS PROVISIONING_EXTERNAL_ID',
  '        unset AWS_CONTAINER_CREDENTIALS_RELATIVE_URI AWS_CONTAINER_CREDENTIALS_FULL_URI AWS_CONTAINER_AUTHORIZATION_TOKEN',
  '        set --',
  '        echo "Assumed $PROVISIONING_ROLE_ARN in account $CELL_ACCOUNT_ID"',
  '        bash "$SCRIPT_PATH"',
].join('\n');

/**
 * The provisioning workflow (architecture.md §7).
 *
 * Resolved execution input (ADR-011 — the service resolves sources, script
 * paths, and failure statuses; the workflow rereads no mutable records):
 *
 * ```
 * {
 *   "sourceType": "GITHUB", "sourceLocation": "https://...",
 *   "sourceVersion": "<full commit SHA or ''>",
 *   "operatorId": "<authorizer sub>", "sessionName": "<STS-safe operator id>",
 *   "accountId": "<12 digits>", "externalId": "<account external id or ''>",
 *   "cellRoleArn": "arn:...:role/<fleet>-cell-provisioning",
 *   "tenantRoleArn": "arn:...:role/<fleet>-tenant-provisioning",
 *   "applicationId": "...", "cellId": "...",
 *   "cellBuild":   { "operation": "create|update|delete",
 *                    "scriptPath": "...", "failedStatus": "...",
 *                    "parameters": { "<NAME>": "<value>" } },         // optional
 *   "tenantId": "...",                                               // when tenantBuild present
 *   "tenantBuild": { "operation": "create|update|delete",
 *                    "scriptPath": "...", "failedStatus": "...",
 *                    "parameters": { "<NAME>": "<value>" },
 *                    "tenantName": "...", "adminEmail": "..." }        // optional
 * }
 * ```
 *
 * `cellBuild` and `tenantBuild` are each optional; the combination encodes
 * the trigger (§8): CreateDeployment into an existing cell (tenant create
 * only), CreateDeployment requiring a new cell (cell create + tenant
 * create), UpdateDeployment (tenant update), DeleteDeployment (tenant
 * delete), UpdateCell (cell update), DeleteCell (cell delete). The
 * deployment record is keyed by `tenantId` and `applicationId` (ADR-037).
 *
 * Each phase's `parameters` is its resolved parameter set (spec R-32 for
 * the tenant build, R-34 for the cell build), always present, `{}` when
 * empty; each entry reaches that phase's build as `PARAM_<NAME>` and no
 * other phase's (ADR-039, ADR-040). The workflow never writes it back
 * (R-21).
 *
 * Input contract: `tenantBuild.tenantName`, `tenantBuild.adminEmail`,
 * `sourceVersion`, and `operatorId` are always present — the service
 * supplies an empty `adminEmail` for non-create operations and an empty
 * `sourceVersion` for an unpinned source; `tenantName` is the name stored on
 * the tenant record and reaches every tenant build as `TENANT_NAME`
 * (ADR-023). A non-empty
 * `sourceVersion` (the stamped supply-chain pin, T5/M10) becomes the
 * CodeBuild `SourceVersion` override; `operatorId` (the verified JWT sub)
 * is forwarded to every build as `OPERATOR_ID` so application-plane changes
 * are attributable to the initiating operator, not just the shared fleet
 * role (T10/M12).
 *
 * Two shared CodeBuild projects with distinct service roles separate cell
 * builds from tenant builds (ADR-002, ADR-012). The project roles hold no
 * application-plane permission (ADR-025): each may only assume its half
 * of the provisioning role pair in the cell's account (`accountId`,
 * `cellRoleArn` / `tenantRoleArn`, `externalId` in the input), and the
 * buildspec does so before the script runs. Every lifecycle transition is
 * compare-and-set on the exact expected status; failure writes are
 * conditional on attribute_exists(PK); the deployment-delete and cell-delete
 * terminal writes are TransactWriteItems (record removal + slot and count
 * release on the cell and tenant, resp. the account and application — §8.2)
 * with a stable ClientRequestToken derived from the execution id. No
 * unconditional writes.
 *
 * CustomState raw ASL is required because the typed CodeBuildStartBuild task
 * does not expose Source*Override parameters, and there is no typed
 * TransactWriteItems task.
 */
export class ProvisioningWorkflow extends Construct {
  readonly stateMachine: sfn.StateMachine;
  /** Shared project for cell builds — its role may assume `<fleet>-cell-provisioning` in any registered account. */
  readonly cellProject: codebuild.Project;
  /** Shared project for tenant builds — its role may assume `<fleet>-tenant-provisioning` in any registered account. */
  readonly tenantProject: codebuild.Project;
  /** The cell build role, `<fleet>-cell-build` (physical name: the account role pair trusts it by ARN). */
  readonly cellBuildRole: iam.Role;
  /** The tenant build role, `<fleet>-tenant-build`. */
  readonly tenantBuildRole: iam.Role;

  private readonly table: dynamodb.ITable;

  constructor(scope: Construct, id: string, props: ProvisioningWorkflowProps) {
    super(scope, id);
    this.table = props.table;

    // ------------------------------------------------------------------
    // Two shared CodeBuild projects (ADR-002 refined by ADR-012, ADR-025).
    // Base source is NO_SOURCE + dummy buildspec: every execution overrides
    // both. The project roles carry NO application-plane permission: each
    // may only assume its half of the provisioning role pair, by name, in
    // any registered account (N-8). The pair in each account — installed by
    // the account owner — is the provisioning blast radius and THE hardening
    // point of the sample (P-12, §6.4).
    // ------------------------------------------------------------------
    // M15 (T13): explicit CodeBuild log groups with bounded retention —
    // the service-created default groups never expire.
    this.cellBuildRole = buildRole(this, 'CellBuildRole', props.fleetName, 'cell');
    const cellProjectLogs = projectLogGroup(this, 'CellProjectLogs');
    this.cellProject = new codebuild.Project(this, 'CellProject', {
      description: 'Cell provisioning (shared cell deployment) - source and buildspec are overridden per StartBuild',
      role: this.cellBuildRole,
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: { build: { commands: ['echo "This buildspec is always overridden"'] } },
      }),
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0 },
      // M17 (T16): bound the cost/concurrency amplification of a leaked
      // token or runaway client — excess builds queue, they do not fan out.
      concurrentBuildLimit: CONCURRENT_BUILD_LIMIT,
      logging: { cloudWatch: { logGroup: cellProjectLogs } },
    });
    acknowledgeCodeBuildDefaults(this.cellProject, cellProjectLogs);

    this.tenantBuildRole = buildRole(this, 'TenantBuildRole', props.fleetName, 'tenant');
    const tenantProjectLogs = projectLogGroup(this, 'TenantProjectLogs');
    this.tenantProject = new codebuild.Project(this, 'TenantProject', {
      description: 'Tenant provisioning (per-tenant deployment) - source and buildspec are overridden per StartBuild',
      role: this.tenantBuildRole,
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: { build: { commands: ['echo "This buildspec is always overridden"'] } },
      }),
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0 },
      // M17 (T16) and M15 (T13) — see CellProject.
      concurrentBuildLimit: CONCURRENT_BUILD_LIMIT,
      logging: { cloudWatch: { logGroup: tenantProjectLogs } },
    });
    acknowledgeCodeBuildDefaults(this.tenantProject, tenantProjectLogs);

    // ------------------------------------------------------------------
    // States — defined leaf-first so transitions can reference them.
    // ------------------------------------------------------------------
    const done = new sfn.Succeed(this, 'Done');

    // ---- Tenant phase (phase 2) ----------------------------------------

    // Failure write: build failure, task timeout, or terminal-write retry
    // exhaustion → tenant to the resolved failedStatus. attribute_exists(PK)
    // so it cannot recreate a concurrently deleted record as a ghost.
    const failTenant = this.updateItemTask('FailTenant', deploymentKey(), {
      updateExpression: 'SET #status = :failed, statusReason = :reason, updatedAt = :now',
      conditionExpression: 'attribute_exists(PK)',
      expressionAttributeValues: {
        ':failed': attrAt('$.tenantBuild.failedStatus'),
        ':reason': attrReason('Tenant provisioning failed'),
        ':now': attrAt('$$.State.EnteredTime'),
      },
    });

    // Failure write carrying the build evidence (README contract): the
    // normalized `$.failure.{buildArn,buildStatus}` fields go into
    // statusReason and lastBuildId. Extracting only these two short fields
    // (never the raw Cause string) keeps statusReason bounded.
    const failTenantWithBuild = this.updateItemTask('FailTenantWithBuild', deploymentKey(), {
      updateExpression:
        'SET #status = :failed, statusReason = :reason, lastBuildId = :buildArn, updatedAt = :now',
      conditionExpression: 'attribute_exists(PK)',
      expressionAttributeValues: {
        ':failed': attrAt('$.tenantBuild.failedStatus'),
        ':reason': attrBuildFailureReason('Tenant provisioning failed'),
        ':buildArn': attrAt('$.failure.buildArn'),
        ':now': attrAt('$$.State.EnteredTime'),
      },
    });

    // Build-failure evidence extraction (tenant). Only the RunTenantBuild
    // Catch enters here, so a States.TaskFailed Cause is the .sync task's
    // Build JSON by contract; every field access is Choice-guarded so the
    // failure path can never itself fail on a missing field, and anything
    // unexpected (task timeout, odd shape) falls through to the generic
    // write keyed off $.error.Error.
    const {
      entry: tenantBuildFailure,
    } = this.buildFailureEvidenceChain('Tenant', failTenantWithBuild, failTenant);

    // Tenant-delete transaction cancellation / retry exhaustion outcome:
    // read the tenant — absence proves the prior delete committed (§7).
    const failTenantDelete = this.updateItemTask('FailTenantDelete', deploymentKey(), {
      updateExpression: 'SET #status = :failed, statusReason = :reason, updatedAt = :now',
      conditionExpression: 'attribute_exists(PK) AND #status = :deleting',
      expressionAttributeValues: {
        ':failed': attr('DELETE_FAILED'),
        ':deleting': attr('DELETING'),
        ':reason': attrReason('Tenant delete failed'),
        ':now': attrAt('$$.State.EnteredTime'),
      },
    });

    const getTenantRecord = new tasks.DynamoGetItem(this, 'GetTenantRecord', {
      table: this.table,
      key: deploymentKey(),
      consistentRead: true,
      resultPath: '$.tenantRecord',
    });
    getTenantRecord.addRetry(transientRetry());
    const tenantDeleteOutcome = new sfn.Choice(this, 'TenantDeleteOutcome')
      // Record still present: the transaction genuinely failed.
      .when(sfn.Condition.isPresent('$.tenantRecord.Item'), failTenantDelete)
      // Missing: a prior attempt committed — the delete succeeded.
      .otherwise(done);
    getTenantRecord.next(tenantDeleteOutcome);

    // §8.2 transaction-shape contract: DeleteItem deployment CONDITION
    // attribute_exists(PK) AND status = DELETING + UpdateItem cell
    // tenantCount - 1 CONDITION attribute_exists(PK) AND tenantCount > 0 +
    // UpdateItem tenant deploymentCount - 1 CONDITION attribute_exists(PK)
    // AND deploymentCount > 0, stable ClientRequestToken. Record removal,
    // slot release and count release cannot diverge; the item-state
    // conditions make replays safe beyond DynamoDB's finite token window
    // (ADR-013, ADR-037). The tenant record always exists here: DeleteTenant
    // refuses while deploymentCount > 0.
    const deleteTenantTransact = new sfn.CustomState(this, 'DeleteDeploymentRecord', {
      stateJson: {
        Type: 'Task',
        Resource: 'arn:aws:states:::aws-sdk:dynamodb:transactWriteItems',
        Parameters: {
          'TransactItems': [
            {
              Delete: {
                TableName: this.table.tableName,
                Key: rawDeploymentKey(),
                ConditionExpression: 'attribute_exists(PK) AND #status = :deleting',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: { ':deleting': { S: 'DELETING' } },
              },
            },
            {
              Update: {
                TableName: this.table.tableName,
                Key: rawCellKey(),
                UpdateExpression: 'SET tenantCount = tenantCount - :one, updatedAt = :now',
                ConditionExpression: 'attribute_exists(PK) AND tenantCount > :zero',
                ExpressionAttributeValues: {
                  ':one': { N: '1' },
                  ':zero': { N: '0' },
                  ':now': { 'S.$': '$$.State.EnteredTime' },
                },
              },
            },
            {
              Update: {
                TableName: this.table.tableName,
                Key: rawTenantKey(),
                UpdateExpression: 'SET deploymentCount = deploymentCount - :one, updatedAt = :now',
                ConditionExpression: 'attribute_exists(PK) AND deploymentCount > :zero',
                ExpressionAttributeValues: {
                  ':one': { N: '1' },
                  ':zero': { N: '0' },
                  ':now': { 'S.$': '$$.State.EnteredTime' },
                },
              },
            },
          ],
          // Stable per execution: short-window duplicate suppression for
          // identical automatic retries (§7). Hashed to fit the 36-char cap.
          'ClientRequestToken.$': "States.Hash(States.Format('deployment-delete:{}', $$.Execution.Id), 'MD5')",
        },
        ResultPath: null,
      },
    });
    addTerminalWriteRetries(deleteTenantTransact);
    deleteTenantTransact.addCatch(getTenantRecord, { resultPath: '$.error' });
    deleteTenantTransact.next(done);

    // Terminal success for tenant create/update: CAS to ACTIVE + lastBuildId.
    const setTenantActiveAfterCreate = this.setActiveTask(
      'SetTenantActiveAfterCreate', deploymentKey(), 'CREATING', '$.tenantBuildResult.Build.Arn');
    const setTenantActiveAfterUpdate = this.setActiveTask(
      'SetTenantActiveAfterUpdate', deploymentKey(), 'UPDATING', '$.tenantBuildResult.Build.Arn');
    // Retry exhaustion routes through the same conditional *_FAILED
    // transition as a build failure (§7 point 3).
    setTenantActiveAfterCreate.addCatch(failTenant, { resultPath: '$.error' });
    setTenantActiveAfterUpdate.addCatch(failTenant, { resultPath: '$.error' });

    const tenantSuccessRouter = new sfn.Choice(this, 'TenantBuildSucceeded')
      .when(sfn.Condition.stringEquals('$.tenantBuild.operation', 'delete'), deleteTenantTransact)
      .when(sfn.Condition.stringEquals('$.tenantBuild.operation', 'update'), setTenantActiveAfterUpdate)
      .otherwise(setTenantActiveAfterCreate);

    const runTenantBuild = this.buildTask('RunTenantBuild', this.tenantProject, 'tenantBuildResult', '$.tenantBuild.parameters', [
      envVar('SCRIPT_PATH', '$.tenantBuild.scriptPath'),
      envVar('TENANT_ID', '$.tenantId'),
      // ADR-023: the tenant's name as stored on the control-plane record, on
      // every operation - onboarding input, not configuration (ADR-004).
      envVar('TENANT_NAME', '$.tenantBuild.tenantName'),
      envVar('APPLICATION_ID', '$.applicationId'),
      envVar('CELL_ID', '$.cellId'),
      envVar('OPERATION', '$.tenantBuild.operation'),
      // Create only; the service supplies an empty string otherwise (§7).
      envVar('ADMIN_EMAIL', '$.tenantBuild.adminEmail'),
      // M12 (T10): the initiating operator (verified JWT sub) — scripts and
      // build logs can attribute application-plane changes to an operator,
      // not just the shared fleet role.
      envVar('OPERATOR_ID', '$.operatorId'),
      // ADR-025: the account the cell lives in and the role the buildspec
      // assumes there before the script runs (§6.1 "Credentials").
      ...accountEnvVars('$.tenantRoleArn'),
      // Then PARAM_<NAME> for each entry of the deployment's resolved set
      // (R-32, §6.1) - tenant builds never see the cell's set.
    ]);
    for (const variant of runTenantBuild.variants) {
      variant.addCatch(tenantBuildFailure, { outputs: BUILD_FAILURE_OUTPUT });
      variant.next(tenantSuccessRouter);
    }

    const checkTenantBuild = new sfn.Choice(this, 'TenantBuildRequested')
      .when(sfn.Condition.isPresent('$.tenantBuild'), runTenantBuild.entry)
      .otherwise(done);

    // ---- Cell phase (phase 1) -------------------------------------------

    // Cell build failure with a pending tenant build (new-cell onboarding):
    // one transaction moves cell AND tenant CREATING→CREATE_FAILED so
    // compensation cannot leave only one record recoverable (§6, ADR-013).
    const failCellAndTenant = new sfn.CustomState(this, 'FailCellAndTenant', {
      stateJson: {
        Type: 'Task',
        Resource: 'arn:aws:states:::aws-sdk:dynamodb:transactWriteItems',
        Parameters: {
          'TransactItems': [
            {
              Update: {
                TableName: this.table.tableName,
                Key: rawCellKey(),
                UpdateExpression: 'SET #status = :failed, statusReason = :reason, updatedAt = :now',
                ConditionExpression: 'attribute_exists(PK) AND #status = :creating',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':failed': { S: 'CREATE_FAILED' },
                  ':creating': { S: 'CREATING' },
                  ':reason': { 'S.$': "States.Format('Cell provisioning failed: {}', $.error.Error)" },
                  ':now': { 'S.$': '$$.State.EnteredTime' },
                },
              },
            },
            {
              Update: {
                TableName: this.table.tableName,
                Key: rawDeploymentKey(),
                UpdateExpression: 'SET #status = :failed, statusReason = :reason, updatedAt = :now',
                ConditionExpression: 'attribute_exists(PK) AND #status = :creating',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':failed': { S: 'CREATE_FAILED' },
                  ':creating': { S: 'CREATING' },
                  ':reason': { S: 'cell provisioning failed' },
                  ':now': { 'S.$': '$$.State.EnteredTime' },
                },
              },
            },
          ],
          'ClientRequestToken.$': "States.Hash(States.Format('cell-failure:{}', $$.Execution.Id), 'MD5')",
        },
        ResultPath: null,
      },
    });
    addTerminalWriteRetries(failCellAndTenant);

    // Cell-only failure write: cell to the resolved failedStatus.
    const failCell = this.updateItemTask('FailCell', cellKey(), {
      updateExpression: 'SET #status = :failed, statusReason = :reason, updatedAt = :now',
      conditionExpression: 'attribute_exists(PK)',
      expressionAttributeValues: {
        ':failed': attrAt('$.cellBuild.failedStatus'),
        ':reason': attrReason('Cell provisioning failed'),
        ':now': attrAt('$$.State.EnteredTime'),
      },
    });

    const cellFailureRouter = new sfn.Choice(this, 'CellFailureHasTenant')
      .when(sfn.Condition.isPresent('$.tenantBuild'), failCellAndTenant)
      .otherwise(failCell);

    // With-build variants (README contract): the cell record additionally
    // gets lastBuildId and a statusReason naming the failed build. The
    // paired transaction keeps the exact same keys, conditions, and token —
    // only WHAT is written changes. The tenant half stays generic: its
    // lastBuildId refers to tenant builds, and the failed build is the cell's.
    const failCellAndTenantWithBuild = new sfn.CustomState(this, 'FailCellAndTenantWithBuild', {
      stateJson: {
        Type: 'Task',
        Resource: 'arn:aws:states:::aws-sdk:dynamodb:transactWriteItems',
        Parameters: {
          'TransactItems': [
            {
              Update: {
                TableName: this.table.tableName,
                Key: rawCellKey(),
                UpdateExpression:
                  'SET #status = :failed, statusReason = :reason, lastBuildId = :buildArn, updatedAt = :now',
                ConditionExpression: 'attribute_exists(PK) AND #status = :creating',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':failed': { S: 'CREATE_FAILED' },
                  ':creating': { S: 'CREATING' },
                  ':reason': {
                    'S.$':
                      "States.Format('Cell provisioning failed: build {} ended with status {}', $.failure.buildArn, $.failure.buildStatus)",
                  },
                  ':buildArn': { 'S.$': '$.failure.buildArn' },
                  ':now': { 'S.$': '$$.State.EnteredTime' },
                },
              },
            },
            {
              Update: {
                TableName: this.table.tableName,
                Key: rawDeploymentKey(),
                UpdateExpression: 'SET #status = :failed, statusReason = :reason, updatedAt = :now',
                ConditionExpression: 'attribute_exists(PK) AND #status = :creating',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':failed': { S: 'CREATE_FAILED' },
                  ':creating': { S: 'CREATING' },
                  ':reason': { S: 'cell provisioning failed' },
                  ':now': { 'S.$': '$$.State.EnteredTime' },
                },
              },
            },
          ],
          'ClientRequestToken.$': "States.Hash(States.Format('cell-failure:{}', $$.Execution.Id), 'MD5')",
        },
        ResultPath: null,
      },
    });
    addTerminalWriteRetries(failCellAndTenantWithBuild);

    const failCellWithBuild = this.updateItemTask('FailCellWithBuild', cellKey(), {
      updateExpression:
        'SET #status = :failed, statusReason = :reason, lastBuildId = :buildArn, updatedAt = :now',
      conditionExpression: 'attribute_exists(PK)',
      expressionAttributeValues: {
        ':failed': attrAt('$.cellBuild.failedStatus'),
        ':reason': attrBuildFailureReason('Cell provisioning failed'),
        ':buildArn': attrAt('$.failure.buildArn'),
        ':now': attrAt('$$.State.EnteredTime'),
      },
    });

    const cellFailureRouterWithBuild = new sfn.Choice(this, 'CellFailureHasTenantWithBuild')
      .when(sfn.Condition.isPresent('$.tenantBuild'), failCellAndTenantWithBuild)
      .otherwise(failCellWithBuild);

    // Build-failure evidence extraction (cell) — see the tenant chain.
    const {
      entry: cellBuildFailure,
    } = this.buildFailureEvidenceChain('Cell', cellFailureRouterWithBuild, cellFailureRouter);

    // Cell-delete condition failure / retry exhaustion outcome: read the
    // cell — absence proves the prior delete committed (§7, ADR-014).
    const failCellDelete = this.updateItemTask('FailCellDelete', cellKey(), {
      updateExpression: 'SET #status = :failed, statusReason = :reason, updatedAt = :now',
      conditionExpression: 'attribute_exists(PK)',
      expressionAttributeValues: {
        ':failed': attr('DELETE_FAILED'),
        ':reason': attrReason('Cell delete failed'),
        ':now': attrAt('$$.State.EnteredTime'),
      },
    });

    const getCellRecord = new tasks.DynamoGetItem(this, 'GetCellRecord', {
      table: this.table,
      key: cellKey(),
      consistentRead: true,
      resultPath: '$.cellRecord',
    });
    getCellRecord.addRetry(transientRetry());
    const cellDeleteOutcome = new sfn.Choice(this, 'CellDeleteOutcome')
      .when(sfn.Condition.isPresent('$.cellRecord.Item'), failCellDelete)
      .otherwise(done);
    getCellRecord.next(cellDeleteOutcome);

    // Terminal cell delete (§8.2, ADR-024, ADR-032): ONE transaction removes
    // the cell, releases its slot on the account and its count on the
    // application — the mirror of the deployment delete one level up.
    // DeleteItem cell CONDITION attribute_exists(PK) AND status = DELETING
    // AND tenantCount = 0 (emptiness as defence in depth — the atomic
    // DELETING transition already excluded occupancy) + UpdateItem account
    // cellCount - 1 CONDITION attribute_exists(PK) AND cellCount > 0 +
    // UpdateItem application cellCount - 1, same condition. Item-state
    // conditions make replays safe beyond the token window: after a
    // committed delete the replay cancels on the cell condition before
    // touching a counter, and the Catch reads the cell — absence proves the
    // prior transaction committed.
    const deleteCellRecord = new sfn.CustomState(this, 'RemoveCellRecord', {
      stateJson: {
        Type: 'Task',
        Resource: 'arn:aws:states:::aws-sdk:dynamodb:transactWriteItems',
        Parameters: {
          'TransactItems': [
            {
              Delete: {
                TableName: this.table.tableName,
                Key: rawCellKey(),
                ConditionExpression: 'attribute_exists(PK) AND #status = :deleting AND tenantCount = :zero',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: { ':deleting': { S: 'DELETING' }, ':zero': { N: '0' } },
              },
            },
            {
              Update: {
                TableName: this.table.tableName,
                Key: rawAccountKey(),
                UpdateExpression: 'SET cellCount = cellCount - :one, updatedAt = :now',
                ConditionExpression: 'attribute_exists(PK) AND cellCount > :zero',
                ExpressionAttributeValues: {
                  ':one': { N: '1' },
                  ':zero': { N: '0' },
                  ':now': { 'S.$': '$$.State.EnteredTime' },
                },
              },
            },
            {
              Update: {
                TableName: this.table.tableName,
                Key: rawApplicationKey(),
                UpdateExpression: 'SET cellCount = cellCount - :one, updatedAt = :now',
                ConditionExpression: 'attribute_exists(PK) AND cellCount > :zero',
                ExpressionAttributeValues: {
                  ':one': { N: '1' },
                  ':zero': { N: '0' },
                  ':now': { 'S.$': '$$.State.EnteredTime' },
                },
              },
            },
          ],
          'ClientRequestToken.$': "States.Hash(States.Format('cell-delete:{}', $$.Execution.Id), 'MD5')",
        },
        ResultPath: null,
      },
    });
    addTerminalWriteRetries(deleteCellRecord);
    deleteCellRecord.addCatch(getCellRecord, { resultPath: '$.error' });
    deleteCellRecord.next(done);

    // Terminal success for cell create/update: CAS to ACTIVE + lastBuildId.
    // The create variant continues to phase 2 (the new-cell onboarding).
    const setCellActiveAfterUpdate = this.setActiveTask(
      'SetCellActiveAfterUpdate', cellKey(), 'UPDATING', '$.cellBuildResult.Build.Arn');
    const setCellActiveAfterCreate = this.setActiveTask(
      'SetCellActiveAfterCreate', cellKey(), 'CREATING', '$.cellBuildResult.Build.Arn');
    // Retry exhaustion routes through the same *_FAILED transition as a
    // build failure — for new-cell onboarding that is the paired transaction,
    // so the pending tenant is failed too (§7 point 3).
    setCellActiveAfterUpdate.addCatch(cellFailureRouter, { resultPath: '$.error' });
    setCellActiveAfterCreate.addCatch(cellFailureRouter, { resultPath: '$.error' });
    setCellActiveAfterCreate.next(checkTenantBuild);

    const cellSuccessRouter = new sfn.Choice(this, 'CellBuildSucceeded')
      .when(sfn.Condition.stringEquals('$.cellBuild.operation', 'delete'), deleteCellRecord)
      .when(sfn.Condition.stringEquals('$.cellBuild.operation', 'update'), setCellActiveAfterUpdate)
      .otherwise(setCellActiveAfterCreate);

    const runCellBuild = this.buildTask('RunCellBuild', this.cellProject, 'cellBuildResult', '$.cellBuild.parameters', [
      envVar('SCRIPT_PATH', '$.cellBuild.scriptPath'),
      envVar('APPLICATION_ID', '$.applicationId'),
      envVar('CELL_ID', '$.cellId'),
      envVar('OPERATION', '$.cellBuild.operation'),
      // M12 (T10) — see the tenant build.
      envVar('OPERATOR_ID', '$.operatorId'),
      // ADR-025 — see the tenant build.
      ...accountEnvVars('$.cellRoleArn'),
      // Then PARAM_<NAME> for each entry of the cell's resolved set (R-34,
      // §6.1) - cell builds never see a deployment's set.
    ]);
    for (const variant of runCellBuild.variants) {
      variant.addCatch(cellBuildFailure, { outputs: BUILD_FAILURE_OUTPUT });
      variant.next(cellSuccessRouter);
    }

    const checkCellBuild = new sfn.Choice(this, 'CellBuildRequested')
      .when(sfn.Condition.isPresent('$.cellBuild'), runCellBuild.entry)
      .otherwise(checkTenantBuild);

    // ------------------------------------------------------------------
    // State machine
    // ------------------------------------------------------------------
    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(checkCellBuild),
      timeout: EXECUTION_TIMEOUT,
      comment: 'Cell/tenant provisioning: optional cell build, optional tenant build, conditional terminal writes',
      // Full execution history to CloudWatch Logs (AwsSolutions-SF1) and
      // X-Ray tracing (AwsSolutions-SF2) - provisioning is the workflow
      // operators will debug, so every state transition is auditable.
      logs: {
        destination: new logs.LogGroup(this, 'StateMachineLogs', {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.DESTROY, // sample only
        }),
        level: sfn.LogLevel.ALL,
      },
      tracingEnabled: true,
    });
    // The logging (logs:CreateLogDelivery etc.) and X-Ray (xray:PutTraceSegments
    // etc.) grants that CDK generates for the two settings above only work with
    // Resource: '*' - neither API family supports resource-level permissions:
    // https://docs.aws.amazon.com/step-functions/latest/dg/cw-logs.html#cloudwatch-iam-policy
    acknowledgeGranularFinding(
      this.stateMachine,
      'AwsSolutions-IAM5[Resource::*]',
      'CDK-generated grant for state machine logging (logs:CreateLogDelivery) and X-Ray tracing - these API families do not support resource-level permissions.',
    );

    // M17 (T16): a surge of provisioning executions is the cost/concurrency
    // amplification signature — a leaked token or runaway client hammering
    // CreateTenant. Alarm only (no actions): sample scope surfaces the
    // signal; a production control plane wires it to an operator channel.
    new cloudwatch.Alarm(this, 'ExecutionSurgeAlarm', {
      metric: this.stateMachine.metricStarted({
        period: Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 20,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'More than 20 provisioning executions started in 5 minutes - possible CreateTenant amplification (threat T16, mitigation M17).',
    });

    // CustomState does not auto-grant. Least-privilege (§7):
    // - StartBuild (+ .sync polling) on exactly the two shared projects.
    // - GetItem/UpdateItem/DeleteItem on the table — TransactWriteItems
    //   authorizes per contained operation, so no extra action is needed.
    this.stateMachine.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['codebuild:StartBuild', 'codebuild:StopBuild', 'codebuild:BatchGetBuilds'],
        resources: [this.cellProject.projectArn, this.tenantProject.projectArn],
      }),
    );
    this.stateMachine.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['events:PutRule', 'events:PutTargets', 'events:DescribeRule'],
        resources: [
          eventsRuleArn(this, 'StepFunctionsGetEventForCodeBuildStartBuildRule'),
        ],
      }),
    );
    // Item operations on the base table only — the workflow never queries
    // the GSIs. (The typed Dynamo tasks auto-grant; this statement is the
    // explicit, documented grant that also covers the two CustomState
    // TransactWriteItems tasks.)
    this.stateMachine.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
        resources: [this.table.tableArn],
      }),
    );

    // Template-scanner (cfn_nag/checkov) annotations - travel with the
    // synthesized templates so scans of the committed integ snapshot see
    // the same documented decisions as cdk-nag at synth time.
    suppressTemplateScanners(this.node.findChild('StateMachineLogs'), {
      cfnNag: [{ id: 'W84', reason: 'Workflow logs carry state-transition metadata; default CloudWatch Logs SSE encryption at rest is sufficient for this sample.' }],
      checkov: [{ id: 'CKV_AWS_158', comment: 'Workflow logs carry state-transition metadata; default CloudWatch Logs SSE encryption at rest is sufficient for this sample.' }],
    });
    const spcmReason = 'Least-privilege policy with granular per-resource statements; the statement-point count reflects explicit scoping, not over-breadth.';
    for (const role of [this.cellBuildRole, this.tenantBuildRole, this.stateMachine.role]) {
      suppressTemplateScanners(role.node.findChild('DefaultPolicy'), {
        cfnNag: [{ id: 'W76', reason: spcmReason }],
      });
    }
    // cfn_nag counterpart of the AwsSolutions-IAM5[Resource::*]
    // acknowledgment above - same CDK-generated grant, same reason.
    suppressTemplateScanners(this.stateMachine.role.node.findChild('DefaultPolicy'), {
      cfnNag: [{ id: 'W12', reason: 'CDK-generated grant for state machine logging (logs:CreateLogDelivery) and X-Ray tracing - these API families do not support resource-level permissions.' }],
    });
  }

  /**
   * Routes a caught build-task error (§7, README contract). The build
   * task's Catch ({@link BUILD_FAILURE_OUTPUT}) has already reduced the
   * error to `$.error.Error` plus, when the `.sync` task's
   * `States.TaskFailed` Cause carried the Build, `$.failure.{buildArn,
   * buildStatus}` - never the raw Cause or a parsed copy of the Build,
   * which echo the build's environment and so every parameter value
   * (§8.1 payload budget). With the evidence the failure write names the
   * build (`withBuild`); without it (task timeout, an unexpected shape) the
   * generic write keyed off `$.error.Error` runs (`fallback`).
   */
  private buildFailureEvidenceChain(
    prefix: string,
    withBuild: sfn.IChainable,
    fallback: sfn.IChainable,
  ): { entry: sfn.Choice } {
    const entry = new sfn.Choice(this, `${prefix}BuildFailureShape`)
      .when(
        sfn.Condition.and(
          sfn.Condition.isPresent('$.failure.buildArn'),
          sfn.Condition.isPresent('$.failure.buildStatus'),
        ),
        withBuild,
      )
      .otherwise(fallback);
    return { entry };
  }

  /**
   * One StartBuild.sync phase with a catchable task-level timeout (§7).
   *
   * Two task variants behind a Choice on the stamped supply-chain pin
   * (T5/M10): a non-empty `$.sourceVersion` adds the CodeBuild
   * `SourceVersion` override so the build fetches exactly the pinned
   * commit; the empty string (unpinned) omits the parameter entirely -
   * CodeBuild's behaviour for an empty-string override is undefined, so it
   * is never sent. Callers wire Catch/Next on BOTH variants and route into
   * `entry`; the Catch takes {@link BUILD_FAILURE_OUTPUT}.
   *
   * The task states use JSONata, the rest of the machine JSONPath. Only
   * JSONata can append one `PARAM_<NAME>` variable per entry of the phase's
   * resolved parameter set (`parametersPath`, a name to value map) to the
   * fixed variables, and only a JSONata Catch can drop the raw error Cause
   * before it enters state. The task `Output` plays the part of a
   * `ResultSelector`: the state keeps its input plus `<resultField>.Build`
   * with the build ARN and status only, because the CodeBuild result echoes
   * the build's environment, values included, and a second copy of each
   * parameter set would pass the 256 KiB state limit (§8.1).
   */
  private buildTask(
    id: string,
    project: codebuild.Project,
    resultField: 'tenantBuildResult' | 'cellBuildResult',
    parametersPath: string,
    environment: EnvVar[],
  ): { entry: sfn.Choice; variants: sfn.CustomState[] } {
    const makeVariant = (taskId: string, withPin: boolean) =>
      new JsonataCustomState(this, taskId, {
        stateJson: {
          Type: 'Task',
          Resource: 'arn:aws:states:::codebuild:startBuild.sync',
          TimeoutSeconds: BUILD_TIMEOUT.toSeconds(),
          Arguments: {
            ProjectName: project.projectName,
            SourceTypeOverride: jsonata(inputRef('$.sourceType')),
            SourceLocationOverride: jsonata(inputRef('$.sourceLocation')),
            ...(withPin ? { SourceVersion: jsonata(inputRef('$.sourceVersion')) } : {}),
            BuildspecOverride: INLINE_BUILDSPEC,
            EnvironmentVariablesOverride: environmentOverride(environment, parametersPath),
          },
          Output: buildResultOutput(resultField),
        },
      });
    const unpinned = makeVariant(id, false);
    const pinned = makeVariant(`${id}Pinned`, true);
    const entry = new sfn.Choice(this, `${id}SourcePin`)
      .when(
        sfn.Condition.and(
          sfn.Condition.isPresent('$.sourceVersion'),
          sfn.Condition.not(sfn.Condition.stringEquals('$.sourceVersion', '')),
        ),
        pinned,
      )
      .otherwise(unpinned);
    return { entry, variants: [pinned, unpinned] };
  }

  /** Compare-and-set to ACTIVE + lastBuildId, conditional on the exact expected in-flight status. */ private setActiveTask(
    id: string,
    key: DynamoKey,
    expectedStatus: 'CREATING' | 'UPDATING',
    buildArnPath: string,
  ): tasks.DynamoUpdateItem {
    return this.updateItemTask(id, key, {
      updateExpression: 'SET #status = :active, lastBuildId = :buildArn, updatedAt = :now REMOVE statusReason',
      conditionExpression: 'attribute_exists(PK) AND #status = :expected',
      expressionAttributeValues: {
        ':active': attr('ACTIVE'),
        ':expected': attr(expectedStatus),
        ':buildArn': attrAt(buildArnPath),
        ':now': attrAt('$$.State.EnteredTime'),
      },
    });
  }

  /** A conditional UpdateItem with the standard terminal-write retry policy. */
  private updateItemTask(
    id: string,
    key: DynamoKey,
    props: {
      updateExpression: string;
      conditionExpression: string;
      expressionAttributeValues: Record<string, tasks.DynamoAttributeValue>;
    },
  ): tasks.DynamoUpdateItem {
    const state = new tasks.DynamoUpdateItem(this, id, {
      table: this.table,
      key,
      updateExpression: props.updateExpression,
      conditionExpression: props.conditionExpression,
      expressionAttributeNames: { '#status': 'status' },
      expressionAttributeValues: props.expressionAttributeValues,
      resultPath: sfn.JsonPath.DISCARD,
    });
    addTerminalWriteRetries(state);
    return state;
  }
}

/**
 * A raw-ASL state in JSONata. `CustomStateProps` has no `queryLanguage`, and
 * without one CDK renders the state's Catch in JSONPath form, dropping its
 * `Output`; overriding the field makes CDK emit `QueryLanguage: JSONata`
 * and render each Catch with `Output`.
 */
// see adr/0041-run-the-build-tasks-in-jsonata.md
class JsonataCustomState extends sfn.CustomState {
  protected override readonly queryLanguage = sfn.QueryLanguage.JSONATA;
}

type DynamoKey = Record<string, tasks.DynamoAttributeValue>;

/** Typed-task key for the deployment record (ADR-037): the tenant's partition, the application's sort key. */
function deploymentKey(): DynamoKey {
  return {
    PK: tasks.DynamoAttributeValue.fromString(
      sfn.JsonPath.format('TENANT#{}', sfn.JsonPath.stringAt('$.tenantId')),
    ),
    SK: tasks.DynamoAttributeValue.fromString(
      sfn.JsonPath.format('DEPLOYMENT#{}', sfn.JsonPath.stringAt('$.applicationId')),
    ),
  };
}

/** Typed-task key for the cell record. */
function cellKey(): DynamoKey {
  return {
    PK: tasks.DynamoAttributeValue.fromString(
      sfn.JsonPath.format('CELL#{}', sfn.JsonPath.stringAt('$.cellId')),
    ),
    SK: tasks.DynamoAttributeValue.fromString('META'),
  };
}

/** Raw ASL key for the deployment record (aws-sdk transactWriteItems parameters). */
function rawDeploymentKey(): object {
  return {
    PK: { 'S.$': "States.Format('TENANT#{}', $.tenantId)" },
    SK: { 'S.$': "States.Format('DEPLOYMENT#{}', $.applicationId)" },
  };
}

/** Raw ASL key for the tenant record (the deployment-delete count release, ADR-037). */
function rawTenantKey(): object {
  return {
    PK: { 'S.$': "States.Format('TENANT#{}', $.tenantId)" },
    SK: { S: 'META' },
  };
}

/** Raw ASL key for the cell record (aws-sdk transactWriteItems parameters). */
function rawCellKey(): object {
  return {
    PK: { 'S.$': "States.Format('CELL#{}', $.cellId)" },
    SK: { S: 'META' },
  };
}

/** Raw ASL key for the account record (the cell-delete slot release, ADR-024). */
function rawAccountKey(): object {
  return {
    PK: { 'S.$': "States.Format('ACCOUNT#{}', $.accountId)" },
    SK: { S: 'META' },
  };
}

/** Raw ASL key for the application record (the cell-delete count release, ADR-032). */
function rawApplicationKey(): object {
  return {
    PK: { 'S.$': "States.Format('APPLICATION#{}', $.applicationId)" },
    SK: { S: 'META' },
  };
}

/**
 * The per-account build environment (ADR-025): the account the cell lives
 * in, the provisioning role the buildspec assumes there (cell or tenant
 * half), the account's external id (empty string when none — the buildspec
 * then omits `--external-id`), and the STS-safe operator session name (M23).
 */
function accountEnvVars(roleArnPath: string): EnvVar[] {
  return [
    envVar('CELL_ACCOUNT_ID', '$.accountId'),
    envVar('PROVISIONING_ROLE_ARN', roleArnPath),
    envVar('PROVISIONING_EXTERNAL_ID', '$.externalId'),
    envVar('OPERATOR_SESSION_NAME', '$.sessionName'),
  ];
}

/**
 * A control-plane build role with its physical name (`<fleet>-<kind>-build`,
 * ADR-025): the account role pair trusts it by ARN, so the name is the
 * cross-account contract. Its only application-facing permission is
 * AssumeRole on `<fleet>-<kind>-provisioning` in ANY account (N-8): accounts
 * are registered at run time, and the target role's trust policy — written
 * by the account owner — is the gate (M20). The CodeBuild Project adds its
 * own log-group grant.
 */
function buildRole(scope: Construct, id: string, fleetName: string, kind: ProvisioningRoleKind): iam.Role {
  const stack = Stack.of(scope);
  const role = new iam.Role(scope, id, {
    roleName: buildRoleName(fleetName, kind),
    assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
    description: `${fleetName} control plane ${kind} build: may only assume ${fleetName}-${kind}-provisioning in registered accounts (ADR-025)`,
  });
  const target = provisioningRoleArn(stack.partition, '*', fleetName, kind);
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: 'AssumeProvisioningRole',
      actions: ['sts:AssumeRole'],
      resources: [target],
    }),
  );
  acknowledgeGranularFinding(
    role,
    `AwsSolutions-IAM5[Resource::${nagFindingResource(role, target)}]`,
    'Accounts are registered at run time (ADR-024), so the AssumeRole resource names the provisioning role by fixed name in any account (spec N-8); the target role\'s trust policy, written by the account owner, is the gate (M20).',
  );
  suppressTemplateScanners(role, {
    cfnNag: [{ id: 'W28', reason: 'The physical name is the cross-account contract: every account role pair trusts this role by ARN (spec §6.4, ADR-025).' }],
  });
  return role;
}

function attr(value: string): tasks.DynamoAttributeValue {
  return tasks.DynamoAttributeValue.fromString(value);
}

/** DynamoDB string attribute resolved from a JSONPath in the state input. */
function attrAt(path: string): tasks.DynamoAttributeValue {
  return tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt(path));
}

/** DynamoDB string attribute formatted from the caught error (baseline pattern). */
function attrReason(prefix: string): tasks.DynamoAttributeValue {
  return tasks.DynamoAttributeValue.fromString(
    // The `{}` is a Step Functions States.Format placeholder, not a template literal.
    // nosemgrep: missing-template-string-indicator
    sfn.JsonPath.format(`${prefix}: {}`, sfn.JsonPath.stringAt('$.error.Error')),
  );
}

/**
 * DynamoDB string attribute naming the failed build from the normalized
 * evidence fields. Formatting only the ARN and status (never the raw Cause)
 * keeps statusReason bounded — no item bloat.
 */
function attrBuildFailureReason(prefix: string): tasks.DynamoAttributeValue {
  return tasks.DynamoAttributeValue.fromString(
    sfn.JsonPath.format(
      // The `{}` are Step Functions States.Format placeholders, not template literals.
      // nosemgrep: missing-template-string-indicator
      `${prefix}: build {} ended with status {}`,
      sfn.JsonPath.stringAt('$.failure.buildArn'),
      sfn.JsonPath.stringAt('$.failure.buildStatus'),
    ),
  );
}

/** One fixed PLAINTEXT build variable: its name and the JSONPath of its value in the execution input. */
export type EnvVar = readonly [name: string, valuePath: string];

/** One fixed PLAINTEXT env var resolved from the execution input. */
function envVar(name: string, valuePath: string): EnvVar {
  return [name, valuePath];
}

/** Wraps a JSONata expression for a JSONata state field. */
function jsonata(expression: string): string {
  return `{% ${expression} %}`;
}

/** The JSONata reference to a field of the state input, from its JSONPath (`$.a.b` → `$states.input.a.b`). */
function inputRef(valuePath: string): string {
  if (!/^\$(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(valuePath)) {
    throw new Error(`Not a plain JSONPath field reference: ${valuePath}`);
  }
  return `$states.input${valuePath.slice(1)}`;
}

/**
 * The `EnvironmentVariablesOverride` of a build task (spec §6.1): the fixed
 * variables, then one `PARAM_<NAME>` per entry of the resolved parameter
 * map at `parametersPath`. The fixed prefix keeps a declared name off the
 * contract's own variables and the build's (`TENANT_ID`, `PATH`). A name
 * with neither a value nor a default is not in the map, so it is absent
 * from the build, never an empty string (R-32).
 */
export function environmentOverride(environment: readonly EnvVar[], parametersPath: string): string {
  const fixed = environment
    .map(([name, path]) => `{"Name": ${JSON.stringify(name)}, "Type": "PLAINTEXT", "Value": ${inputRef(path)}}`)
    .join(', ');
  const parameters =
    `$each(${inputRef(parametersPath)}, function($v, $k) {{"Name": "PARAM_" & $k, "Type": "PLAINTEXT", "Value": $v}})`;
  return jsonata(`$append([${fixed}], ${parameters})`);
}

/**
 * A build task's `Output` (§8.1): the state input plus the build ARN and
 * status under `<resultField>.Build` - what the terminal writes read
 * (`lastBuildId`) and nothing else from the CodeBuild result.
 */
export function buildResultOutput(resultField: string): string {
  return jsonata(
    `$merge([$states.input, {"${resultField}": {"Build": {"Arn": $states.result.Build.Arn, "BuildStatus": $states.result.Build.BuildStatus}}}])`,
  );
}

/**
 * A build task's Catch `Output` (§8.1): the state input plus `error.Error`
 * and, when the `.sync` task's `States.TaskFailed` Cause is the Build JSON
 * (wrapped as `{"Build": {...}}` or bare, both layouts are seen), the
 * build's ARN and status as `failure.{buildArn, buildStatus}`. The raw
 * Cause and the parsed Build never enter state: they echo the build's
 * environment, every parameter value included, and could pass the 256 KiB
 * limit, which fails the execution with `States.DataLimitExceeded` before
 * any `*_FAILED` write runs. `$parse` runs only on a string Cause of a
 * `States.TaskFailed`, the same guard the JSONPath chain had; a timeout or
 * any other shape keeps only `error.Error`, for the generic failure write.
 */
export const BUILD_FAILURE_OUTPUT = jsonata([
  '(',
  '$e := $states.errorOutput;',
  "$cause := ($e.Error = 'States.TaskFailed' and $type($e.Cause) = 'string') ? $parse($e.Cause);",
  "$build := ($type($cause.Build.Arn) = 'string' and $type($cause.Build.BuildStatus) = 'string') ? $cause.Build",
  "  : (($type($cause.Arn) = 'string' and $type($cause.BuildStatus) = 'string') ? $cause);",
  '$merge([$states.input, {"error": {"Error": $e.Error}},',
  '  $exists($build) ? {"failure": {"buildArn": $build.Arn, "buildStatus": $build.BuildStatus}} : {}])',
  ')',
].join(' '));

/**
 * Terminal-write retry policy (§7 point 3): retry transient failures, but
 * never a condition failure or transaction cancellation — those are
 * definitive outcomes routed by the task's Catch.
 */
function addTerminalWriteRetries(state: { addRetry(props: sfn.RetryProps): unknown }): void {
  state.addRetry({
    errors: [
      'DynamoDB.ConditionalCheckFailedException',
      'DynamoDb.ConditionalCheckFailedException',
      'DynamoDb.TransactionCanceledException',
    ],
    maxAttempts: 0,
  });
  state.addRetry(transientRetry());
}

function transientRetry(): sfn.RetryProps {
  return {
    errors: ['States.ALL'],
    interval: Duration.seconds(2),
    backoffRate: 2,
    maxAttempts: 6,
  };
}

function eventsRuleArn(scope: Construct, ruleName: string): string {
  return Stack.of(scope).formatArn({
    service: 'events',
    resource: 'rule',
    resourceName: ruleName,
    arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
  });
}

/**
 * Acknowledges the findings raised by the grants that the CodeBuild Project
 * construct generates for its own service role, plus the absence of a
 * customer-managed encryption key:
 * - AwsSolutions-IAM5 on the project's explicit CloudWatch Logs log-group
 *   (`:*` is the log-stream suffix) and report-group (`-*` is the group
 *   suffix) - both scoped to this project by construction.
 * - AwsSolutions-CB4: the projects produce no build artifacts (source and
 *   buildspec are overridden per StartBuild; output goes to CloudWatch Logs
 *   and SSM), so there is nothing for a KMS key to encrypt.
 */
function acknowledgeCodeBuildDefaults(project: codebuild.Project, logGroup: logs.ILogGroup): void {
  const stack = Stack.of(project);
  const defaultLogGroupArn = stack.formatArn({
    service: 'logs',
    resource: 'log-group',
    resourceName: `/aws/codebuild/${project.projectName}`,
    arnFormat: ArnFormat.COLON_RESOURCE_NAME,
  });
  const reportGroupArn = stack.formatArn({
    service: 'codebuild',
    resource: 'report-group',
    resourceName: `${project.projectName}-*`,
    arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
  });
  // The Project construct grants on the default log path regardless of the
  // explicit log group (which it grants separately, wildcard-free) — both
  // acknowledgments are kept so either grant shape stays covered. The grant
  // lands on the build role's DefaultPolicy (the role is created by this
  // construct, ADR-025), so the acknowledgment is recorded on the role as
  // well as on the project.
  for (const scope of [project, project.role!]) {
    for (const arn of [`${defaultLogGroupArn}:*`, `${logGroup.logGroupArn}:*`]) {
      acknowledgeGranularFinding(
        scope,
        `AwsSolutions-IAM5[Resource::${nagFindingResource(project, arn)}]`,
        'CDK-generated grant on the project\'s own log group - the wildcard is the log-stream suffix.',
      );
    }
    acknowledgeGranularFinding(
      scope,
      `AwsSolutions-IAM5[Resource::${nagFindingResource(project, reportGroupArn)}]`,
      'CDK-generated grant on the project\'s own report group namespace.',
    );
  }
  Validations.of(project).acknowledge({
    id: 'AwsSolutions-CB4',
    reason: 'No build artifacts to encrypt: source and buildspec are overridden per StartBuild; output goes to CloudWatch Logs and SSM.',
  });
}

/**
 * An explicit CodeBuild project log group with bounded retention (M15,
 * threat T13): the service-created default group (`/aws/codebuild/<name>`)
 * never expires and exists outside the stack. One month keeps build output
 * (which may name tenant/cell identifiers) available for incident review
 * without indefinite accumulation.
 */
function projectLogGroup(scope: Construct, id: string): logs.LogGroup {
  const logGroup = new logs.LogGroup(scope, id, {
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.DESTROY, // sample only
  });
  suppressTemplateScanners(logGroup, {
    cfnNag: [{ id: 'W84', reason: 'Build logs carry provisioning script output; default CloudWatch Logs SSE encryption at rest is sufficient for this sample.' }],
    checkov: [{ id: 'CKV_AWS_158', comment: 'Build logs carry provisioning script output; default CloudWatch Logs SSE encryption at rest is sufficient for this sample.' }],
  });
  return logGroup;
}
