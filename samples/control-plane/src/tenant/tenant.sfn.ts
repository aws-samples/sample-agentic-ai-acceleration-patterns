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
import {
  HookRunner,
  JsonataCustomState,
  hookMetricNamespace,
  scriptOutputsFields,
  scriptOutputsRawField,
  withoutScriptOutputsRaw,
  HOOK_SKIPPED_METRIC_NAME,
  SCRIPT_OUTPUTS_REJECTED_REASON,
} from './hook.workflow';
import { recordEventStates } from './record-event.workflow';
import {
  buildProjectArn,
  buildProjectName,
  buildRoleName,
  hookRoleName,
  provisioningRoleArn,
  ProvisioningRoleKind,
  BuildProjectKind,
  SESSION_TAG_KEYS,
  sessionTagConditions,
  workflowName,
} from '../shared/fleet';
import { nagFindingResource, acknowledgeGranularFinding, suppressTemplateScanners } from '../shared/nag';

export interface ProvisioningWorkflowProps {
  /** The control plane table (accounts + cells + tenants; terminal state is written directly to it). */
  readonly table: dynamodb.ITable;
  /**
   * Names the two build roles (`<fleet>-cell-build`, `<fleet>-tenant-build`)
   * and the provisioning role pair they may assume in any registered
   * account (`<fleet>-cell-provisioning`, `<fleet>-tenant-provisioning`),
   * spec §3.3 / §6.4, ADR-025. Already validated by the stack. It also names
   * the four build projects and the workflow with physical names
   * (`src/shared/fleet.ts`, R-41), so their ARNs are computable before they
   * exist.
   */
  readonly fleetName: string;
  /**
   * The role every global hook runs under, `<fleet>-global-hook` (spec R-41,
   * ADR-044): created by the stack, which owns its trust (CodeBuild only, on
   * `aws:SourceArn` of the global hook project), its attached managed
   * policies and the explicit deny. The workflow names it as the service
   * role of the global hook project `<fleet>-global-hook` and never passes it
   * as a role override, nor holds `iam:PassRole` on it. Supplied together
   * with `appHookRole`.
   */
  readonly globalHookRole: iam.IRole;
  /**
   * The role every application hook runs under, `<fleet>-app-hook` (spec
   * R-41), supplied and used as `globalHookRole` is, for the application
   * hook project `<fleet>-app-hook`. Never the same role as `globalHookRole`:
   * an application hook cannot use what a global hook holds.
   */
  readonly appHookRole: iam.IRole;
  /**
   * Concurrent builds per CodeBuild project (M17, ADR-0046). Already
   * validated by the stack: an integer from 1 to 100, default 5.
   */
  readonly concurrentBuildLimit: number;
}

/**
 * Catchable per-build budget (task-level TimeoutSeconds on each StartBuild
 * task). A timeout surfaces as States.Timeout and is caught like a build
 * failure (architecture.md §7).
 */
export const BUILD_TIMEOUT = Duration.hours(1);

/**
 * A script build's `StartBuild` refused at the project's
 * `concurrentBuildLimit` (`CodeBuild.AccountLimitExceededException`, spec
 * H-9) waits for a free slot (ADR-0049): a retry every 30 seconds or less
 * (full jitter, so waiting executions do not poll CodeBuild in step), 40
 * times, about 10 minutes in all and never more than 20. A refused start
 * creates no build, so the retry sends no idempotency token. The task's
 * `TimeoutSeconds` applies to each attempt, so the wait is outside the
 * build budget (R-23).
 */
export const BUILD_SLOT_WAIT = {
  error: 'CodeBuild.AccountLimitExceededException',
  intervalSeconds: 30,
  maxAttempts: 40,
} as const;

/** A terminal transaction cancelled by a concurrent one (ADR-0049): retried with jitter, at most 31 s of waits. */
export const TRANSACTION_CANCELED_RETRY = {
  error: 'DynamoDb.TransactionCanceledException',
  intervalSeconds: 1,
  backoffRate: 2,
  maxAttempts: 5,
} as const;

/**
 * Execution timeout (R-23): greater than every build budget an execution can
 * run at the caps, queue time and hook backoff included, plus terminal-write
 * margin. A delete at the caps is the longest: 10 hooks at 144 minutes each
 * (3 attempts of 47 and 3 of backoff) plus a 60-minute script and its
 * 20-minute build-slot wait (BUILD_SLOT_WAIT) is 1,520 minutes (25.3 h); a
 * new-cell create is 1,100 (18.3 h). It is a final safety
 * net, not the normal timeout path: that is the catchable task-level timeout
 * above and the hook attempt's own deadline (R-46). A tripped execution
 * timeout bypasses the Catch and strands records.
 */
export const EXECUTION_TIMEOUT = Duration.hours(26);

/** The build variable that holds each session tag's value (ADR-0051). */
const SESSION_TAG_VARIABLES: Readonly<Record<string, string>> = {
  CellId: 'CELL_ID',
  TenantId: 'TENANT_ID',
  ApplicationId: 'APPLICATION_ID',
};

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
 *
 * The AssumeRole passes the session tags of its half (ADR-0051,
 * {@link SESSION_TAG_KEYS}), all transitive, so every session in the chain
 * names the cell, and on a tenant build the tenant and the application. The
 * values are only the service-resolved `CELL_ID`, `TENANT_ID` and
 * `APPLICATION_ID` (never a `PARAM_` variable, R-32), quoted, in the same
 * argument array as the external id. A pair whose trust does not allow
 * `sts:TagSession` refuses the AssumeRole, so the first build fails.
 * The two halves differ only in that line.
 */
export const INLINE_BUILDSPECS: Readonly<Record<ProvisioningRoleKind, string>> = {
  cell: inlineBuildspec('cell'),
  tenant: inlineBuildspec('tenant'),
};

/** The `--tags` and `--transitive-tag-keys` arguments of one half, appended to the AssumeRole argument array. */
function sessionTagArguments(kind: ProvisioningRoleKind): string {
  const keys = SESSION_TAG_KEYS[kind];
  const tags = keys.map((key) => `"Key=${key},Value=$${SESSION_TAG_VARIABLES[key]}"`).join(' ');
  return `set -- "$@" --tags ${tags} --transitive-tag-keys ${keys.join(' ')}`;
}

function inlineBuildspec(kind: ProvisioningRoleKind): string {
  return [
    'version: 0.2',
    'env:',
    '  shell: bash',
    // R-43: SCRIPT_OUTPUTS is the build's only exported variable (spike H-1:
    // the total of exported variables is limited, and overflow is silent).
    '  exported-variables:',
    '    - SCRIPT_OUTPUTS',
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
    `        ${sessionTagArguments(kind)}`,
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
    // R-43: a fresh directory outside the source tree, and a path in it that
    // does not yet exist, so nothing committed to the source stands in for output.
    '        OUTPUTS_DIR=$(mktemp -d)',
    '        OUTPUTS_FILE="$OUTPUTS_DIR/outputs.json"',
    '        export OUTPUTS_FILE',
    '        bash "$SCRIPT_PATH"',
    // R-43: after the script succeeded, parse the file, refuse a repeated key,
    // check the rest, and export the compact re-serialisation (never the
    // file's bytes), always: `{}` when the script wrote none. A file that
    // fails fails create and update, and is dropped on delete (P-9). This is
    // a format check in the container the script just ran in, not a trust
    // boundary; the workflow checks the value again (T40, T44).
    "        SCRIPT_OUTPUTS='{}'",
    '        OUTPUTS_ERROR=""',
    '        if [ -e "$OUTPUTS_FILE" ] || [ -L "$OUTPUTS_FILE" ]; then',
    '          if [ -L "$OUTPUTS_FILE" ]; then',
    '            OUTPUTS_ERROR="OUTPUTS_FILE is a symbolic link"',
    String.raw`          elif ! jq -e 'type == "object" and ([to_entries[] | (.key | test("\\A[A-Za-z][A-Za-z0-9_]{0,63}\\z")) and (.value | type == "string" and test("\\A[ -~]*\\z"))] | all)' "$OUTPUTS_FILE" > /dev/null 2>&1; then`,
    '            OUTPUTS_ERROR="OUTPUTS_FILE is not a JSON object of valid keys and printable ASCII string values"',
    "          elif [ \"$(jq -n --stream '[inputs | select(length == 2) | .[0][0]] | (length != (unique | length))' \"$OUTPUTS_FILE\")\" = true ]; then",
    '            OUTPUTS_ERROR="OUTPUTS_FILE repeats a key"',
    '          else',
    '            COMPACT=$(jq -c . "$OUTPUTS_FILE")',
    '            if [ "$(printf %s "$COMPACT" | wc -c)" -gt 4096 ]; then',
    '              OUTPUTS_ERROR="OUTPUTS_FILE is longer than 4096 bytes in compact form"',
    '            else',
    '              SCRIPT_OUTPUTS="$COMPACT"',
    '            fi',
    '          fi',
    '        fi',
    '        if [ -n "$OUTPUTS_ERROR" ]; then',
    '          if [ "$OPERATION" = delete ]; then',
    '            echo "Dropping the script outputs on delete: $OUTPUTS_ERROR"',
    '          else',
    '            echo "Script outputs rejected: $OUTPUTS_ERROR"',
    '            exit 1',
    '          fi',
    '        fi',
    '        export SCRIPT_OUTPUTS',
  ].join('\n');
}

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
 * An input with a top-level `recordEvent` (`RecordEventWorkflowInput`,
 * §8.4) is a record event instead: it runs no build, only the record's
 * hooks, commit and terminal write (`record-event.workflow.ts`, R-50).
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
 * application-plane permission (ADR-025): each may only assume, and tag a
 * session for (ADR-0051), its half of the provisioning role pair in the
 * cell's account (`accountId`,
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
  /** Shared project for global hooks, `<fleet>-global-hook`, under the global hook role (R-41). */
  readonly globalHookProject: codebuild.Project;
  /** Shared project for application hooks, `<fleet>-app-hook`, under the application hook role (R-41). */
  readonly appHookProject: codebuild.Project;
  /** The hook sub-graph (§8.3): one copy, entered once per hook list. */
  readonly hooks: HookRunner;

  private readonly table: dynamodb.ITable;

  constructor(scope: Construct, id: string, props: ProvisioningWorkflowProps) {
    super(scope, id);
    this.table = props.table;

    // ------------------------------------------------------------------
    // Two shared CodeBuild projects (ADR-002 refined by ADR-012, ADR-025).
    // Base source is NO_SOURCE + dummy buildspec: every execution overrides
    // both. The project roles carry NO application-plane permission: each
    // may only assume, and tag a session for, its half of the provisioning
    // role pair, by name, in any registered account (N-8, ADR-0051). The pair in each account — installed by
    // the account owner — is the provisioning blast radius and THE hardening
    // point of the sample (P-12, §6.4).
    // ------------------------------------------------------------------
    // M15 (T13): explicit CodeBuild log groups with bounded retention —
    // the service-created default groups never expire.
    this.cellBuildRole = buildRole(this, 'CellBuildRole', props.fleetName, 'cell');
    const cellProjectLogs = projectLogGroup(this, 'CellProjectLogs');
    this.cellProject = new codebuild.Project(this, 'CellProject', {
      projectName: buildProjectName(props.fleetName, 'cell-build'),
      description: 'Cell provisioning (shared cell deployment) - source and buildspec are overridden per StartBuild',
      role: this.cellBuildRole,
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: { build: { commands: ['echo "This buildspec is always overridden"'] } },
      }),
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0 },
      // M17 (T16): each CreateDeployment, UpdateDeployment, UpdateCell and
      // DeleteCell fans out to CodeBuild, so a leaked token or a runaway
      // client is a cost amplification vector. The cap bounds the parallel
      // spend: CodeBuild refuses a start over it, and the workflow waits
      // for a free slot for about 10 minutes before it fails the operation
      // (BUILD_SLOT_WAIT, ADR-0049). The deployer sets it (ADR-0046,
      // default 5).
      concurrentBuildLimit: props.concurrentBuildLimit,
      logging: { cloudWatch: { logGroup: cellProjectLogs } },
    });
    acknowledgeCodeBuildDefaults(this.cellProject, cellProjectLogs);

    this.tenantBuildRole = buildRole(this, 'TenantBuildRole', props.fleetName, 'tenant');
    const tenantProjectLogs = projectLogGroup(this, 'TenantProjectLogs');
    this.tenantProject = new codebuild.Project(this, 'TenantProject', {
      projectName: buildProjectName(props.fleetName, 'tenant-build'),
      description: 'Tenant provisioning (per-tenant deployment) - source and buildspec are overridden per StartBuild',
      role: this.tenantBuildRole,
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: { build: { commands: ['echo "This buildspec is always overridden"'] } },
      }),
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0 },
      // M17 (T16) and M15 (T13) — see CellProject.
      concurrentBuildLimit: props.concurrentBuildLimit,
      logging: { cloudWatch: { logGroup: tenantProjectLogs } },
    });
    acknowledgeCodeBuildDefaults(this.tenantProject, tenantProjectLogs);

    // ------------------------------------------------------------------
    // Two hook projects, one per scope (R-41, ADR-044). Each runs under its
    // own role, so an application hook cannot use what a global hook holds;
    // the workflow never sends a role override. Source and buildspec are
    // overridden per StartBuild, as for the provisioning projects, so
    // whoever can start a build in one runs code as its role: only the
    // workflow role may, and it holds no iam:PassRole on either hook role.
    // ------------------------------------------------------------------
    const globalHookRole = props.globalHookRole;
    const appHookRole = props.appHookRole;
    this.globalHookProject = hookProject(this, 'GlobalHookProject', props.fleetName, 'global-hook', globalHookRole,
      'Global hooks - source and buildspec are overridden per StartBuild', props.concurrentBuildLimit);
    this.appHookProject = hookProject(this, 'AppHookProject', props.fleetName, 'app-hook', appHookRole,
      'Application hooks - source and buildspec are overridden per StartBuild', props.concurrentBuildLimit);
    this.hooks = new HookRunner(this, 'Hooks', {
      fleetName: props.fleetName,
      metricNamespace: hookMetricNamespace(props.fleetName),
    });

    // ------------------------------------------------------------------
    // States — defined leaf-first so transitions can reference them.
    // ------------------------------------------------------------------
    const done = new sfn.Succeed(this, 'Done');

    // ---- Tenant phase (phase 2) ----------------------------------------

    // Failure write: build failure, task timeout, or terminal-write retry
    // exhaustion → tenant to the resolved failedStatus. attribute_exists(PK)
    // so it cannot recreate a concurrently deleted record as a ghost.
    const failTenant = this.updateItemTask('FailTenant', deploymentKey(), {
      updateExpression: `SET #status = :failed, statusReason = :reason, ${LAST_GLOBAL_HOOKS_SET}, updatedAt = :now`,
      conditionExpression: 'attribute_exists(PK)',
      expressionAttributeValues: {
        ':failed': attrAt('$.tenantBuild.failedStatus'),
        ':reason': attrReason('Tenant provisioning failed'),
        ...lastGlobalHooksValue(),
        ':now': attrAt('$$.State.EnteredTime'),
      },
    });

    // A failed hook, or script outputs the workflow rejected (R-43, R-46):
    // `$.failureReason` is the statusReason, built where the failure was seen.
    const failTenantWithReason = this.updateItemTask('FailTenantWithReason', deploymentKey(), {
      updateExpression: `SET #status = :failed, statusReason = :reason, ${LAST_GLOBAL_HOOKS_SET}, updatedAt = :now`,
      conditionExpression: 'attribute_exists(PK)',
      expressionAttributeValues: {
        ':failed': attrAt('$.tenantBuild.failedStatus'),
        ':reason': attrAt('$.failureReason'),
        ...lastGlobalHooksValue(),
        ':now': attrAt('$$.State.EnteredTime'),
      },
    });

    // Failure write carrying the build evidence (README contract): the
    // normalized `$.failure.{buildArn,buildStatus}` fields go into
    // statusReason and lastBuildId. Extracting only these two short fields
    // (never the raw Cause string) keeps statusReason bounded.
    const failTenantWithBuild = this.updateItemTask('FailTenantWithBuild', deploymentKey(), {
      updateExpression:
        `SET #status = :failed, statusReason = :reason, lastBuildId = :buildArn, ${LAST_GLOBAL_HOOKS_SET}, updatedAt = :now`,
      conditionExpression: 'attribute_exists(PK)',
      expressionAttributeValues: {
        ':failed': attrAt('$.tenantBuild.failedStatus'),
        ':reason': attrBuildFailureReason('Tenant provisioning failed'),
        ':buildArn': attrAt('$.failure.buildArn'),
        ...lastGlobalHooksValue(),
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
    } = this.buildFailureEvidenceChain('Tenant', failTenantWithBuild, failTenant, failTenantWithReason);

    // Tenant-delete transaction cancellation / retry exhaustion outcome:
    // read the tenant — absence proves the prior delete committed (§7).
    const failTenantDelete = this.updateItemTask('FailTenantDelete', deploymentKey(), {
      updateExpression: `SET #status = :failed, statusReason = :reason, ${LAST_GLOBAL_HOOKS_SET}, updatedAt = :now`,
      conditionExpression: 'attribute_exists(PK) AND #status = :deleting',
      expressionAttributeValues: {
        ':failed': attr('DELETE_FAILED'),
        ':deleting': attr('DELETING'),
        ':reason': attrReason('Tenant delete failed'),
        ...lastGlobalHooksValue(),
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
    // After the script: outputs the guard rejected fail a create or update
    // (`$.failureReason`, R-43); otherwise the post hooks run (R-45), then
    // the terminal write.
    const tenantScriptChecked = new sfn.Choice(this, 'TenantScriptChecked')
      .when(sfn.Condition.isPresent('$.failureReason'), failTenantWithReason)
      .otherwise(this.hooks.tenantPost);
    const tenantScriptOutputs = this.scriptOutputsCheck('TenantScriptOutputs', 'tenantBuild', tenantScriptChecked);
    for (const variant of runTenantBuild.variants) {
      variant.addCatch(tenantBuildFailure, { outputs: BUILD_FAILURE_OUTPUT });
      variant.next(tenantScriptOutputs);
    }

    // The deployment event's pre hooks (global, then application) run before its script (R-45).
    const checkTenantBuild = new sfn.Choice(this, 'TenantBuildRequested')
      .when(sfn.Condition.isPresent('$.tenantBuild'), this.hooks.tenantPre)
      .otherwise(done);

    // ---- Cell phase (phase 1) -------------------------------------------

    // Cell build failure with a pending tenant build (new-cell onboarding):
    // one transaction moves cell AND tenant CREATING→CREATE_FAILED so
    // compensation cannot leave only one record recoverable (§6, ADR-013).
    const failCellAndTenant = this.failCellAndTenantTransaction('FailCellAndTenant', {
      reason: { 'S.$': "States.Format('Cell provisioning failed: {}', $.error.Error)" },
    });

    // Cell-only failure write: cell to the resolved failedStatus.
    const failCell = this.updateItemTask('FailCell', cellKey(), {
      updateExpression: `SET #status = :failed, statusReason = :reason, ${LAST_GLOBAL_HOOKS_SET}, updatedAt = :now`,
      conditionExpression: 'attribute_exists(PK)',
      expressionAttributeValues: {
        ':failed': attrAt('$.cellBuild.failedStatus'),
        ':reason': attrReason('Cell provisioning failed'),
        ...lastGlobalHooksValue(),
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
    const failCellAndTenantWithBuild = this.failCellAndTenantTransaction('FailCellAndTenantWithBuild', {
      reason: {
        'S.$':
          "States.Format('Cell provisioning failed: build {} ended with status {}', $.failure.buildArn, $.failure.buildStatus)",
      },
      buildArn: { 'S.$': '$.failure.buildArn' },
    });
    // A failed hook or rejected script outputs (R-43, R-46): the reason was built where the failure was seen.
    const failCellAndTenantWithReason = this.failCellAndTenantTransaction('FailCellAndTenantWithReason', {
      reason: { 'S.$': '$.failureReason' },
    });

    const failCellWithBuild = this.updateItemTask('FailCellWithBuild', cellKey(), {
      updateExpression:
        `SET #status = :failed, statusReason = :reason, lastBuildId = :buildArn, ${LAST_GLOBAL_HOOKS_SET}, updatedAt = :now`,
      conditionExpression: 'attribute_exists(PK)',
      expressionAttributeValues: {
        ':failed': attrAt('$.cellBuild.failedStatus'),
        ':reason': attrBuildFailureReason('Cell provisioning failed'),
        ':buildArn': attrAt('$.failure.buildArn'),
        ...lastGlobalHooksValue(),
        ':now': attrAt('$$.State.EnteredTime'),
      },
    });

    const failCellWithReason = this.updateItemTask('FailCellWithReason', cellKey(), {
      updateExpression: `SET #status = :failed, statusReason = :reason, ${LAST_GLOBAL_HOOKS_SET}, updatedAt = :now`,
      conditionExpression: 'attribute_exists(PK)',
      expressionAttributeValues: {
        ':failed': attrAt('$.cellBuild.failedStatus'),
        ':reason': attrAt('$.failureReason'),
        ...lastGlobalHooksValue(),
        ':now': attrAt('$$.State.EnteredTime'),
      },
    });
    const cellFailureRouterWithReason = new sfn.Choice(this, 'CellFailureHasTenantWithReason')
      .when(sfn.Condition.isPresent('$.tenantBuild'), failCellAndTenantWithReason)
      .otherwise(failCellWithReason);

    const cellFailureRouterWithBuild = new sfn.Choice(this, 'CellFailureHasTenantWithBuild')
      .when(sfn.Condition.isPresent('$.tenantBuild'), failCellAndTenantWithBuild)
      .otherwise(failCellWithBuild);

    // Build-failure evidence extraction (cell) — see the tenant chain.
    const {
      entry: cellBuildFailure,
    } = this.buildFailureEvidenceChain('Cell', cellFailureRouterWithBuild, cellFailureRouter, cellFailureRouterWithReason);

    // Cell-delete condition failure / retry exhaustion outcome: read the
    // cell — absence proves the prior delete committed (§7, ADR-014).
    const failCellDelete = this.updateItemTask('FailCellDelete', cellKey(), {
      updateExpression: `SET #status = :failed, statusReason = :reason, ${LAST_GLOBAL_HOOKS_SET}, updatedAt = :now`,
      conditionExpression: 'attribute_exists(PK)',
      expressionAttributeValues: {
        ':failed': attr('DELETE_FAILED'),
        ':reason': attrReason('Cell delete failed'),
        ...lastGlobalHooksValue(),
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
    const cellScriptChecked = new sfn.Choice(this, 'CellScriptChecked')
      .when(sfn.Condition.isPresent('$.failureReason'), cellFailureRouterWithReason)
      .otherwise(this.hooks.cellPost);
    const cellScriptOutputs = this.scriptOutputsCheck('CellScriptOutputs', 'cellBuild', cellScriptChecked);
    for (const variant of runCellBuild.variants) {
      variant.addCatch(cellBuildFailure, { outputs: BUILD_FAILURE_OUTPUT });
      variant.next(cellScriptOutputs);
    }

    const checkCellBuild = new sfn.Choice(this, 'CellBuildRequested')
      .when(sfn.Condition.isPresent('$.cellBuild'), this.hooks.cellPre)
      .otherwise(checkTenantBuild);

    // ---- Record events (§8.4, R-50, ADR-045) ------------------------------
    // An input with a top-level `recordEvent` runs no build: PRE hooks, the
    // commit in the script's place, POST hooks, the terminal write.
    const record = recordEventStates(this, {
      tableName: this.table.tableName,
      hooks: this.hooks,
      addWriteRetries: addTerminalWriteRetries,
    });
    const checkRecordEvent = sfn.Choice.jsonata(this, 'RecordEventRequested')
      .when(sfn.Condition.jsonata('{% $exists($states.input.recordEvent) %}'), this.hooks.recordPre)
      .otherwise(checkCellBuild);

    // The six ways out of the hook sub-graph (R-45): a list that ran leads
    // on to the script or the commit (pre) or the success router (post); a
    // failed create or update hook leads to the failure write of its build
    // or record (R-46, §8.2, R-50).
    this.hooks.connect({
      cellPre: runCellBuild.entry,
      cellPost: cellSuccessRouter,
      tenantPre: runTenantBuild.entry,
      tenantPost: tenantSuccessRouter,
      recordPre: record.afterPre,
      recordPost: record.afterPost,
      cellFailure: cellFailureRouterWithReason,
      tenantFailure: failTenantWithReason,
      recordFailure: record.failure,
    });

    // ------------------------------------------------------------------
    // State machine
    // ------------------------------------------------------------------
    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      // Physical name (R-41): the stack's deny and the API's grant name the workflow by ARN, computed before it exists.
      stateMachineName: workflowName(props.fleetName),
      definitionBody: sfn.DefinitionBody.fromChainable(checkRecordEvent),
      timeout: EXECUTION_TIMEOUT,
      comment: 'Cell/tenant provisioning: optional cell build, optional tenant build, conditional terminal writes; or one record event (hooks, commit, terminal write)',
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
    // The hook builds (R-41, R-46): start, stop and poll, on the two hook
    // projects only. No iam:PassRole on either hook role: a role override
    // fails at the CodeBuild API whatever a definition sends.
    this.stateMachine.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'RunHookBuilds',
        actions: ['codebuild:StartBuild', 'codebuild:StopBuild', 'codebuild:BatchGetBuilds'],
        resources: [this.globalHookProject.projectArn, this.appHookProject.projectArn],
      }),
    );
    // The count of skipped delete hooks (R-46, T42). PutMetricData has no
    // resource-level permission, so the resource is `*` (a ProtoShield
    // iam-least-privilege finding, accepted); the condition limits
    // it to the one fixed namespace the workflow writes, `<fleet>/hooks`
    // (hookMetricNamespace), asserted in test/tenant/hook-workflow.test.ts.
    this.stateMachine.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'CountSkippedHooks',
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': hookMetricNamespace(props.fleetName) } },
      }),
    );
    // A skipped delete hook can leave an external system holding state for a
    // record that is gone (T42). Alarm only, no actions, as for M17.
    new cloudwatch.Alarm(this, 'HookSkippedAlarm', {
      metric: new cloudwatch.Metric({
        namespace: hookMetricNamespace(props.fleetName),
        metricName: HOOK_SKIPPED_METRIC_NAME,
        statistic: 'Sum',
        period: Duration.minutes(5),
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'A delete hook was skipped (three failed attempts, or its budget ran out): an external system may hold state for a record that is gone (threat T42, R-46).',
    });
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
    // TransactWriteItems tasks and the record event writes of R-50: the
    // update commit and its probe (UpdateItem), the delete commit and its
    // probe (DeleteItem), the success and failure writes (UpdateItem).)
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
   * generic write keyed off `$.error.Error` runs (`fallback`). A start still
   * refused at the build limit when its wait ended (ADR-0049) started no
   * build: `$.failureReason` names the refusal and the reason write runs
   * (`withReason`).
   */
  private buildFailureEvidenceChain(
    prefix: string,
    withBuild: sfn.IChainable,
    fallback: sfn.IChainable,
    withReason: sfn.IChainable,
  ): { entry: sfn.Choice } {
    const refused = new sfn.Pass(this, `${prefix}BuildStartRefused`, {
      result: sfn.Result.fromString(buildStartRefusedReason(prefix)),
      resultPath: '$.failureReason',
    });
    refused.next(withReason);
    const entry = new sfn.Choice(this, `${prefix}BuildFailureShape`)
      .when(sfn.Condition.stringEquals('$.error.Error', BUILD_SLOT_WAIT.error), refused)
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
   * The outputs guard after a script task (R-43): a one-branch `Parallel`
   * around a JSONata `Pass` that applies the guard. A `Pass` has no Catch;
   * the `Parallel` fails with the branch's error name and catches it, so an
   * evaluation error of the guard is told apart from the task's own errors.
   * On delete it yields `{}`, on create and update it is a rejection.
   */
  private scriptOutputsCheck(id: string, phase: 'cellBuild' | 'tenantBuild', next: sfn.Choice): sfn.Parallel {
    const guard = sfn.Pass.jsonata(this, `${id}Guard`, { outputs: scriptOutputsGuardOutput(phase) });
    const check = sfn.Parallel.jsonata(this, id, { outputs: jsonata('$states.result[0]') });
    check.branch(guard);
    check.addCatch(next, { outputs: scriptOutputsErrorOutput(phase) });
    check.next(next);
    return check;
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
   * `entry`; the Catch takes {@link BUILD_FAILURE_OUTPUT}. Both variants
   * carry the build-slot wait ({@link BUILD_SLOT_WAIT}, ADR-0049).
   *
   * The task states use JSONata, the rest of the machine JSONPath. Only
   * JSONata can append one `PARAM_<NAME>` variable per entry of the phase's
   * resolved parameter set (`parametersPath`, a name to value map) to the
   * fixed variables, and only a JSONata Catch can drop the raw error Cause
   * before it enters state. The task `Output` plays the part of a
   * `ResultSelector`: the state keeps its input plus only
   * `<resultField>.Build` (build ARN and status) and `scriptOutputsRaw`
   * (the raw `SCRIPT_OUTPUTS`, or `false` when it is absent or longer than
   * 4,096 characters) for the guard state that follows (R-43). It drops
   * the rest because the CodeBuild result echoes the build's environment,
   * values included, and a second copy of each parameter set would pass
   * the 256 KiB state limit (§8.1).
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
            BuildspecOverride: INLINE_BUILDSPECS[resultField === 'cellBuildResult' ? 'cell' : 'tenant'],
            EnvironmentVariablesOverride: environmentOverride(environment, parametersPath),
          },
          Output: buildResultOutput(resultField),
        },
      });
    const unpinned = makeVariant(id, false);
    const pinned = makeVariant(`${id}Pinned`, true);
    // ADR-0049: a start refused at the build limit waits for a free slot; the only retrier, so no `States.ALL` can match first.
    for (const variant of [unpinned, pinned]) {
      variant.addRetry({
        errors: [BUILD_SLOT_WAIT.error],
        interval: Duration.seconds(BUILD_SLOT_WAIT.intervalSeconds),
        backoffRate: 1,
        maxAttempts: BUILD_SLOT_WAIT.maxAttempts,
        jitterStrategy: sfn.JitterType.FULL,
      });
    }
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

  /**
   * The paired failure transaction of a new-cell create (§8.2, ADR-013):
   * cell and deployment CREATING to CREATE_FAILED in one transaction. The
   * cell half carries the reason, optionally the failed build and the
   * global hooks that ran (`$.lastGlobalHooks`, R-40); the deployment half
   * is always "cell provisioning failed" and lists none, because its event
   * never ran. The keys, conditions and token are the same for all three.
   */
  private failCellAndTenantTransaction(
    id: string,
    props: { reason: Record<string, string>; buildArn?: Record<string, string> },
  ): sfn.CustomState {
    const state = new sfn.CustomState(this, id, {
      stateJson: {
        Type: 'Task',
        Resource: 'arn:aws:states:::aws-sdk:dynamodb:transactWriteItems',
        Parameters: {
          'TransactItems': [
            {
              Update: {
                TableName: this.table.tableName,
                Key: rawCellKey(),
                UpdateExpression: props.buildArn === undefined
                  ? `SET #status = :failed, statusReason = :reason, ${LAST_GLOBAL_HOOKS_SET}, updatedAt = :now`
                  : `SET #status = :failed, statusReason = :reason, lastBuildId = :buildArn, ${LAST_GLOBAL_HOOKS_SET}, updatedAt = :now`,
                ConditionExpression: 'attribute_exists(PK) AND #status = :creating',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':failed': { S: 'CREATE_FAILED' },
                  ':creating': { S: 'CREATING' },
                  ':reason': props.reason,
                  ...(props.buildArn === undefined ? {} : { ':buildArn': props.buildArn }),
                  ':lgh': { 'L.$': '$.lastGlobalHooks' },
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
    addTerminalWriteRetries(state);
    return state;
  }

  /** Compare-and-set to ACTIVE + lastBuildId, conditional on the exact expected in-flight status. */ private setActiveTask(
    id: string,
    key: DynamoKey,
    expectedStatus: 'CREATING' | 'UPDATING',
    buildArnPath: string,
  ): tasks.DynamoUpdateItem {
    return this.updateItemTask(id, key, {
      updateExpression: `SET #status = :active, lastBuildId = :buildArn, ${LAST_GLOBAL_HOOKS_SET}, updatedAt = :now REMOVE statusReason`,
      conditionExpression: 'attribute_exists(PK) AND #status = :expected',
      expressionAttributeValues: {
        ':active': attr('ACTIVE'),
        ':expected': attr(expectedStatus),
        ':buildArn': attrAt(buildArnPath),
        ...lastGlobalHooksValue(),
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
 * cross-account contract. Its only application-facing permissions are
 * AssumeRole, and TagSession with its half's session tags (ADR-0051), on
 * `<fleet>-<kind>-provisioning` in ANY account (N-8): accounts
 * are registered at run time, and the target role's trust policy — written
 * by the account owner — is the gate (M20). The CodeBuild Project adds its
 * own log-group grant.
 */
function buildRole(scope: Construct, id: string, fleetName: string, kind: ProvisioningRoleKind): iam.Role {
  const stack = Stack.of(scope);
  const role = new iam.Role(scope, id, {
    roleName: buildRoleName(fleetName, kind),
    // R-41, H-7: CodeBuild only, and only for the project of this name. The ARN
    // is computed from the project's fixed physical name, never taken from the
    // project, whose ServiceRole is this role (a reference would close a cycle).
    assumedBy: new iam.PrincipalWithConditions(new iam.ServicePrincipal('codebuild.amazonaws.com'), {
      ArnEquals: {
        'aws:SourceArn': buildProjectArn(stack.partition, stack.region, stack.account, fleetName, `${kind}-build` as BuildProjectKind),
      },
    }),
    description: `${fleetName} control plane ${kind} build: may only assume and tag a session for ${fleetName}-${kind}-provisioning in registered accounts (ADR-025, ADR-0051)`,
  });
  const target = provisioningRoleArn(stack.partition, '*', fleetName, kind);
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: 'AssumeProvisioningRole',
      actions: ['sts:AssumeRole'],
      resources: [target],
    }),
  );
  // ADR-0051: a cross-account AssumeRole that passes session tags needs
  // sts:TagSession on both sides; here only with exactly this half's tags.
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: 'TagProvisioningSession',
      actions: ['sts:TagSession'],
      resources: [target],
      conditions: sessionTagConditions(kind),
    }),
  );
  acknowledgeGranularFinding(
    role,
    `AwsSolutions-IAM5[Resource::${nagFindingResource(role, target)}]`,
    'Accounts are registered at run time (ADR-024), so the AssumeRole and TagSession resource names the provisioning role by fixed name in any account (spec N-8); the target role\'s trust policy, written by the account owner, is the gate (M20). TagSession is limited to the session tags of ADR-0051.',
  );
  suppressTemplateScanners(role, {
    cfnNag: [{ id: 'W28', reason: 'The physical name is the cross-account contract: every account role pair trusts this role by ARN (spec §6.4, ADR-025).' }],
  });
  return role;
}

/**
 * The `lastGlobalHooks` attribute of a cell or deployment record (R-40, §8.2):
 * every terminal write that leaves the record in place sets it, from
 * `$.lastGlobalHooks`, the global hooks that ran for the event in run order
 * as a DynamoDB list of maps (`hookId`, `phase`, `revision`, and
 * `sourceVersion` and `resolvedSourceVersion` when there are any), empty when
 * none ran. The workflow's `StoreHookRuns` state builds it.
 */
const LAST_GLOBAL_HOOKS_SET = 'lastGlobalHooks = :lgh';

function lastGlobalHooksValue(): Record<string, tasks.DynamoAttributeValue> {
  return { ':lgh': tasks.DynamoAttributeValue.listFromJsonPath(sfn.JsonPath.stringAt('$.lastGlobalHooks')) };
}

/**
 * A hook project (R-41): physical name `<fleet>-<kind>`, the hook role of its
 * scope, the provisioning projects' concurrency cap and log retention (M15,
 * M17). Source and buildspec are overridden per StartBuild.
 */
function hookProject(
  scope: Construct,
  id: string,
  fleetName: string,
  kind: 'global-hook' | 'app-hook',
  role: iam.IRole,
  description: string,
  concurrentBuildLimit: number,
): codebuild.Project {
  const logGroup = projectLogGroup(scope, `${id}Logs`);
  const project = new codebuild.Project(scope, id, {
    projectName: buildProjectName(fleetName, kind),
    description,
    role,
    buildSpec: codebuild.BuildSpec.fromObject({
      version: '0.2',
      phases: { build: { commands: ['echo "This buildspec is always overridden"'] } },
    }),
    environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0 },
    concurrentBuildLimit,
    logging: { cloudWatch: { logGroup } },
  });
  acknowledgeCodeBuildDefaults(project, logGroup);
  return project;
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

/** The statusReason of a build whose start was refused for its whole wait (ADR-0049). */
export function buildStartRefusedReason(prefix: string): string {
  const minutes = (BUILD_SLOT_WAIT.intervalSeconds * BUILD_SLOT_WAIT.maxAttempts) / 60;
  return `${prefix} provisioning failed: the build never started, CodeBuild refused it at a concurrent build limit `
    + '(the project\'s or the account\'s) '
    + `after ${BUILD_SLOT_WAIT.maxAttempts} retries over at most ${minutes} minutes (${BUILD_SLOT_WAIT.error})`;
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
 * (`lastBuildId`) - and the raw `SCRIPT_OUTPUTS` for the guard state that
 * follows (R-43), and nothing else from the CodeBuild result.
 */
export function buildResultOutput(resultField: string): string {
  return jsonata(
    `$merge([$states.input, {"${resultField}": {"Build": {"Arn": $states.result.Build.Arn, "BuildStatus": $states.result.Build.BuildStatus}}}, ${scriptOutputsRawField()}])`,
  );
}

/**
 * The guard state's `Output` (R-43): the state input without the raw
 * outputs, plus `scriptOutputs` or `failureReason`.
 */
export function scriptOutputsGuardOutput(phase: 'cellBuild' | 'tenantBuild'): string {
  return jsonata(`$merge([${withoutScriptOutputsRaw('$states.input')}, ${scriptOutputsFields(`$states.input.${phase}.operation`)}])`);
}

/**
 * The Catch `Output` of the guard's `Parallel` state (R-43): the guard is a
 * format check that should never raise, so an error is a defect, and on
 * delete it still yields `{}` so cleanup stays reachable (P-9); on create
 * and update it is a rejection. The guard runs in a state of its own, after
 * the build task, so an evaluation error of the task's `Arguments` takes
 * the task's build-failure Catch instead and never skips a delete script.
 */
export function scriptOutputsErrorOutput(phase: 'cellBuild' | 'tenantBuild'): string {
  return jsonata(
    `$merge([${withoutScriptOutputsRaw('$states.input')}, $states.input.${phase}.operation = 'delete' ? {"scriptOutputs": "{}"} : {"failureReason": "${SCRIPT_OUTPUTS_REJECTED_REASON}"}])`,
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
 * any `*_FAILED` write runs.
 *
 * The two fields are read with regular expressions on the raw Cause, never
 * with `$parse`: JSONata has no try/catch, so a Cause that is not valid
 * JSON (a truncated one, for instance, once large parameter sets make the
 * Build JSON long) would make this catcher itself fail, and then no
 * `*_FAILED` write would run (P-9). `Arn` and `BuildStatus` come before
 * `Environment` in the Build, so they survive truncation, and the first
 * match is the build's own: a quote inside an environment value is escaped
 * in the Cause, so a value cannot forge a `"Arn":"..."` pair. A timeout, a
 * non-string Cause or a Cause without both fields keeps only
 * `error.Error`, for the generic failure write.
 */
export const BUILD_FAILURE_OUTPUT = jsonata([
  '(',
  '$e := $states.errorOutput;',
  "$text := ($e.Error = 'States.TaskFailed' and $type($e.Cause) = 'string') ? $e.Cause;",
  String.raw`$arn := $exists($text) ? $match($text, /"Arn"\s*:\s*"([^"]+)"/, 1).groups[0];`,
  String.raw`$status := $exists($text) ? $match($text, /"BuildStatus"\s*:\s*"([A-Z_]+)"/, 1).groups[0];`,
  '$merge([$states.input, {"error": {"Error": $e.Error}},',
  '  ($exists($arn) and $exists($status)) ? {"failure": {"buildArn": $arn, "buildStatus": $status}} : {}])',
  ')',
].join(' '));

/**
 * Terminal-write retry policy (§7 point 3, ADR-0049): a condition failure is
 * a definitive outcome routed by the task's Catch, never retried. A
 * transaction cancellation is retried a few times with jitter: a `Retry`
 * matches the error name only, and the name is the same for a cancellation
 * by a concurrent transaction on the cell (`TransactionConflict`, which
 * applied nothing and clears on its own) and by a failed condition (which
 * fails the same way each time and then reaches the Catch). Every
 * transaction carries a stable token and item-state conditions, so a retry
 * is safe (ADR-013). Other failures get the transient retry.
 */
function addTerminalWriteRetries(state: { addRetry(props: sfn.RetryProps): unknown }): void {
  state.addRetry({
    errors: [
      'DynamoDB.ConditionalCheckFailedException',
      'DynamoDb.ConditionalCheckFailedException',
    ],
    maxAttempts: 0,
  });
  state.addRetry({
    errors: [TRANSACTION_CANCELED_RETRY.error],
    interval: Duration.seconds(TRANSACTION_CANCELED_RETRY.intervalSeconds),
    backoffRate: TRANSACTION_CANCELED_RETRY.backoffRate,
    maxAttempts: TRANSACTION_CANCELED_RETRY.maxAttempts,
    jitterStrategy: sfn.JitterType.FULL,
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
