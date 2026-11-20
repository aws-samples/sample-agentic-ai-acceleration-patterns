// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The cell account check the control-plane slice runs before every run (platform stress
 * test, docs/stress-test.spec.md §3.7; stress ADR-0012). A cell account holds only the cell
 * bootstrap (`CDKToolkit-cell`), the role pair (`<fleet>-cell-account`), the owner's
 * account-base stacks (tagged `stress:part=account-base`, deployed without a service role,
 * and on the owner's list by stack ARN) and cells (deployed under the cell bootstrap's
 * execution role). The check refuses anything else, a stack with another service role, a
 * default CDK bootstrap role (`cdk-hnb659fds-*`), a role pair on `/cell/` or under a cell
 * boundary, and a `/cell/` role that trusts a principal outside the account or a service
 * the cell does not use. Pure: the driver gathers the state with the stack list,
 * `iam:ListRoles` and `iam:GetRole`, and this decides.
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
  }
  return problems;
}
