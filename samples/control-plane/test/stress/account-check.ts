// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The cell account check the control-plane slice runs before every run (platform stress
 * test, docs/stress-test.spec.md §3.7; stress ADR-0012). A cell account holds only the cell
 * bootstrap (`CDKToolkit-cell`), the role pair (`<fleet>-cell-account`), the owner's
 * account-base stacks (tagged `stress:part=account-base`, deployed without a service role,
 * and on the owner's list by stack ARN) and cells (deployed under the cell bootstrap's
 * execution role). The check refuses anything else, a stack with another service role, a
 * default CDK bootstrap role (`cdk-hnb659fds-*`), a role pair on `/cell/`, under a cell
 * boundary, holding a policy its stack did not give it or trusted by anything but the
 * platform account's build and API roles of the fleet, and a `/cell/` role that trusts a
 * principal outside the account or a service the cell does not use. Pure: the driver
 * gathers the state with the stack list, `iam:ListRoles`, and for the role pair
 * `iam:GetRole`, `iam:ListAttachedRolePolicies`, `iam:ListRolePolicies` and
 * `iam:GetRolePolicy`, and this decides.
 */

export const CELL_TOOLKIT_STACK = 'CDKToolkit-cell';
export const ACCOUNT_BASE_TAG = { key: 'stress:part', value: 'account-base' } as const;
const CELL_PATH = '/cell/';
const DEFAULT_BOOTSTRAP_ROLE = /^cdk-hnb659fds-/;
/** Both cell boundaries, with any suffix (stress/application/cell-policies.ts). */
const CELL_BOUNDARY = /:policy\/(cell-permissions-boundary|cell-workload-boundary)(-[a-z0-9]{1,16})?$/;
/** The services a runtime-isolation cell's roles trust: Lambda functions and AgentCore. */
export const CELL_TRUSTED_SERVICES: readonly string[] = ['lambda.amazonaws.com', 'bedrock-agentcore.amazonaws.com'];

export interface StackState {
  readonly name: string;
  readonly arn: string;
  readonly region: string;
  readonly roleArn?: string;
  readonly tags: Readonly<Record<string, string>>;
  /** The root stack's ARN, for a nested stack. */
  readonly rootArn?: string;
}

export interface RoleState {
  readonly name: string;
  readonly path: string;
  readonly arn: string;
  /** The trust policy as IAM returns it (decoded). */
  readonly trust: unknown;
  /** Only known for the roles the driver read with `iam:GetRole`. */
  readonly boundaryArn?: string;
  /** Managed policy ARNs attached to the role; read for the role pair only. */
  readonly attached?: readonly string[];
  /** Inline policies by name with their documents; read for the role pair only. */
  readonly inline?: readonly { readonly name: string; readonly document: unknown }[];
}

export interface AccountState {
  readonly accountId: string;
  readonly partition: string;
  readonly stacks: readonly StackState[];
  readonly roles: readonly RoleState[];
  /** The role pair's two roles, read with `iam:GetRole`; undefined when missing. */
  readonly pair: { readonly cell?: RoleState; readonly tenant?: RoleState };
}

export interface CheckInput {
  readonly fleet: string;
  readonly accountBaseStackArns: readonly string[];
  /** `CELL_POLICY_SUFFIX` of the owner stacks: the owner policies carry it. Default none. */
  readonly policySuffix?: string;
  /** The platform account, the only principal the role pair trusts. */
  readonly platformAccountId: string;
}

/**
 * Problems with a role pair half's trust policy: it must be what control-plane's
 * `CellAccountStack` writes (and `stress/test/role-pair-app.test.ts` pins), exactly one
 * statement that allows `sts:AssumeRole` to the platform account's root, conditioned on
 * `ArnEquals aws:PrincipalArn` naming exactly the fleet's `<fleet>-<kind>-build` and
 * `<fleet>-api` roles, with no other condition. A vendor-owned cell account carries no
 * external id (control-plane ADR-0029).
 */
export function pairTrustProblems(half: 'cell' | 'tenant', role: RoleState, s: AccountState, input: CheckInput): string[] {
  const root = `arn:${s.partition}:iam::${input.platformAccountId}:root`;
  const expected = [
    `arn:${s.partition}:iam::${input.platformAccountId}:role/${input.fleet}-${half}-build`,
    `arn:${s.partition}:iam::${input.platformAccountId}:role/${input.fleet}-api`,
  ].sort();
  const statements = asList((role.trust as { Statement?: unknown } | null)?.Statement) as Record<string, unknown>[];
  const wrong = `role pair ${half} role ${role.name} has a trust policy other than its stack's`;
  if (statements.length !== 1) return [wrong];
  const st = statements[0] ?? {};
  const keys = Object.keys(st).filter((k) => k !== 'Sid').sort();
  const actions = asList(st.Action).map(String);
  const principal = (st.Principal ?? {}) as Record<string, unknown>;
  const awsPrincipals = asList(principal.AWS).map(String);
  const condition = (st.Condition ?? {}) as Record<string, Record<string, unknown>>;
  const arns = asList(condition.ArnEquals?.['aws:PrincipalArn']).map(String).sort();
  const ok =
    JSON.stringify(keys) === JSON.stringify(['Action', 'Condition', 'Effect', 'Principal']) &&
    st.Effect === 'Allow' &&
    actions.length === 1 && actions[0] === 'sts:AssumeRole' &&
    JSON.stringify(Object.keys(principal)) === JSON.stringify(['AWS']) &&
    awsPrincipals.length === 1 && (awsPrincipals[0] === root || awsPrincipals[0] === input.platformAccountId) &&
    JSON.stringify(Object.keys(condition)) === JSON.stringify(['ArnEquals']) &&
    JSON.stringify(Object.keys(condition.ArnEquals ?? {})) === JSON.stringify(['aws:PrincipalArn']) &&
    JSON.stringify(arns) === JSON.stringify(expected);
  return ok ? [] : [wrong];
}

/** The owner policy the role pair stack attaches to each half (stress ADR-0012, control-plane ADR-0047). */
const PAIR_POLICY = { cell: 'cell-build-policy', tenant: 'cell-tenant-build-policy' } as const;
/** The inline policy the role pair stack gives each half: CDK's default policy of the role. */
const PAIR_INLINE = { cell: /^RolesCellProvisioningRoleDefaultPolicy[0-9A-F]{8}$/, tenant: /^RolesTenantProvisioningRoleDefaultPolicy[0-9A-F]{8}$/ } as const;
/** What that default policy grants: the control plane's SSM namespace grants (control-plane §6.2). */
const PAIR_INLINE_ACTIONS: readonly string[] = [
  'ssm:AddTagsToResource',
  'ssm:DeleteParameter',
  'ssm:GetParameter',
  'ssm:GetParameters',
  'ssm:GetParametersByPath',
  'ssm:PutParameter',
];

/**
 * Problems with what the role pair half holds beyond its own stack's set: a managed policy
 * other than its owner policy, an inline policy other than the stack's default policy, or a
 * default policy that grants anything but the SSM namespace actions on
 * `/application-plane/` parameters.
 */
export function pairPolicyProblems(half: 'cell' | 'tenant', role: RoleState, s: AccountState, suffix = ''): string[] {
  const problems: string[] = [];
  const expected = `arn:${s.partition}:iam::${s.accountId}:policy/${PAIR_POLICY[half]}${suffix}`;
  const attached = role.attached ?? [];
  for (const arn of attached.filter((a) => a !== expected)) {
    problems.push(`role pair ${half} role ${role.name} has a managed policy outside its stack's set (${arn.split(':policy/')[1] ?? arn})`);
  }
  if (!attached.includes(expected)) problems.push(`role pair ${half} role ${role.name} lacks ${PAIR_POLICY[half]}${suffix}`);
  const inline = role.inline ?? [];
  for (const p of inline) {
    if (!PAIR_INLINE[half].test(p.name)) {
      problems.push(`role pair ${half} role ${role.name} has an inline policy outside its stack's set (${p.name})`);
      continue;
    }
    const prefix = `arn:${s.partition}:ssm:`;
    for (const raw of asList((p.document as { Statement?: unknown } | null)?.Statement)) {
      const st = (raw ?? {}) as { Effect?: string; Action?: unknown; NotAction?: unknown; Resource?: unknown; NotResource?: unknown };
      if (st.Effect !== 'Allow') continue;
      const actions = asList(st.Action).map(String);
      const resources = asList(st.Resource).map(String);
      const ok =
        st.NotAction === undefined &&
        st.NotResource === undefined &&
        actions.length > 0 &&
        actions.every((a) => PAIR_INLINE_ACTIONS.includes(a)) &&
        resources.length > 0 &&
        resources.every((r) => r.startsWith(prefix) && r.includes(`:${s.accountId}:parameter/application-plane/`));
      if (!ok) problems.push(`role pair ${half} role ${role.name}: inline policy ${p.name} grants more than the SSM namespace actions`);
    }
  }
  if (inline.length > 1) problems.push(`role pair ${half} role ${role.name} has ${inline.length} inline policies, its stack makes one`);
  return problems;
}

const executionRoleArn = (s: AccountState, region: string): string =>
  `arn:${s.partition}:iam::${s.accountId}:role/cdk-cell-cfn-exec-role-${s.accountId}-${region}`;

/** What kind of stack this is, or a problem. */
function stackKind(s: AccountState, st: StackState, input: CheckInput): { kind: string } | { problem: string } {
  const exec = executionRoleArn(s, st.region);
  if (st.roleArn !== undefined && st.roleArn !== exec) {
    return { problem: `stack ${st.name} (${st.region}) has a service role other than the cell execution role` };
  }
  if (st.roleArn === exec) return { kind: 'cell' };
  if (st.name === CELL_TOOLKIT_STACK) return { kind: 'cell-bootstrap' };
  if (st.name === `${input.fleet}-cell-account`) return { kind: 'role-pair' };
  if (st.tags[ACCOUNT_BASE_TAG.key] === ACCOUNT_BASE_TAG.value) {
    return input.accountBaseStackArns.includes(st.arn)
      ? { kind: 'account-base' }
      : { problem: `stack ${st.name} (${st.region}) is tagged account-base but is not on the owner's list of account-base stack ARNs` };
  }
  return { problem: `stack ${st.name} (${st.region}) is not a kind a cell account may hold (cell bootstrap, role pair, account base, cell)` };
}

const asList = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** The principals an Allow statement of a trust policy names that are outside the account and the cell's services. */
export function outsidePrincipals(trust: unknown, accountId: string, partition: string): string[] {
  const out: string[] = [];
  const statements = asList((trust as { Statement?: unknown } | null)?.Statement);
  const inAccount = (p: string): boolean =>
    p === accountId || p.startsWith(`arn:${partition}:iam::${accountId}:`) || p.startsWith(`arn:${partition}:sts::${accountId}:`);
  for (const raw of statements) {
    const st = (raw ?? {}) as { Effect?: string; Principal?: unknown; NotPrincipal?: unknown };
    if (st.Effect !== 'Allow') continue;
    if (st.NotPrincipal !== undefined) {
      out.push('NotPrincipal');
      continue;
    }
    if (st.Principal === '*') {
      out.push('*');
      continue;
    }
    const principal = (st.Principal ?? {}) as Record<string, unknown>;
    for (const [type, values] of Object.entries(principal)) {
      for (const v of asList(values)) {
        const value = String(v);
        if (type === 'AWS' && inAccount(value)) continue;
        if (type === 'Service' && CELL_TRUSTED_SERVICES.includes(value)) continue;
        out.push(`${type}:${value === '*' ? '*' : type === 'AWS' ? 'another account' : value}`);
      }
    }
  }
  return out;
}

/** Problems with one cell account; none when it holds only what §3.7 allows. */
export function accountProblems(s: AccountState, input: CheckInput): string[] {
  const problems: string[] = [];
  const kinds = new Map<string, string>();
  for (const st of s.stacks) {
    const k = stackKind(s, st, input);
    if ('kind' in k) kinds.set(st.arn, k.kind);
  }
  for (const st of s.stacks) {
    if (st.rootArn !== undefined && st.rootArn !== st.arn) {
      // A nested stack is what its root is.
      if (!kinds.has(st.rootArn)) problems.push(`nested stack ${st.name} (${st.region}) belongs to a stack the check refuses`);
      continue;
    }
    const k = stackKind(s, st, input);
    if ('problem' in k) problems.push(k.problem);
  }
  if (!s.stacks.some((st) => st.name === CELL_TOOLKIT_STACK)) problems.push(`no ${CELL_TOOLKIT_STACK} stack: run bootstrap-cell.sh`);
  if (!s.stacks.some((st) => st.name === `${input.fleet}-cell-account`)) problems.push(`no ${input.fleet}-cell-account stack: run deploy-role-pair.sh`);

  for (const r of s.roles) {
    if (DEFAULT_BOOTSTRAP_ROLE.test(r.name)) problems.push(`role ${r.name} belongs to a default CDK bootstrap, which a cell account must not hold`);
    if (r.path.startsWith(CELL_PATH)) {
      const outside = outsidePrincipals(r.trust, s.accountId, s.partition);
      if (outside.length > 0) problems.push(`role ${r.path}${r.name} is trusted from outside the account (${[...new Set(outside)].join(', ')})`);
    }
  }
  for (const [half, role] of Object.entries(s.pair)) {
    if (role === undefined) {
      problems.push(`the role pair has no ${half} role`);
      continue;
    }
    if (role.path !== '/') problems.push(`role pair ${half} role ${role.name} is on ${role.path}, not /`);
    if (role.boundaryArn !== undefined && CELL_BOUNDARY.test(role.boundaryArn)) {
      problems.push(`role pair ${half} role ${role.name} is under a cell boundary`);
    }
    problems.push(...pairPolicyProblems(half as 'cell' | 'tenant', role, s, input.policySuffix ?? ''));
    problems.push(...pairTrustProblems(half as 'cell' | 'tenant', role, s, input));
  }
  return problems;
}
