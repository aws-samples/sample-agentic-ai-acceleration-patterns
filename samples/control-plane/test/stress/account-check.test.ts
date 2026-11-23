// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { type AccountState, accountProblems, outsidePrincipals, type RoleState, type StackState } from './account-check';

const ACCOUNT = '111111111111';
const OTHER = '222222222222';
const REGION = 'eu-central-1';
const FLEET = 'stressw5';
const EXEC = `arn:aws:iam::${ACCOUNT}:role/cdk-cell-cfn-exec-role-${ACCOUNT}-${REGION}`;
const arn = (name: string, id = '00000000-0000-0000-0000-000000000001'): string => `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${name}/${id}`;
const BASE = [arn('CellPolicies'), arn('CellAccountBase')];

const stack = (name: string, extra: Partial<StackState> = {}): StackState => ({ name, arn: arn(name), region: REGION, tags: {}, ...extra });
const trust = (principal: unknown): unknown => ({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: principal, Action: 'sts:AssumeRole' }] });
const role = (name: string, path: string, principal: unknown = { Service: 'lambda.amazonaws.com' }, boundaryArn?: string): RoleState => ({
  name,
  path,
  arn: `arn:aws:iam::${ACCOUNT}:role${path}${name}`,
  trust: trust(principal),
  boundaryArn,
});

/** The session tag keys each half's build passes (control-plane ADR-0051), written out so the test does not read them from the code it checks. */
const TAG_KEYS = { cell: ['CellId'], tenant: ['CellId', 'TenantId', 'ApplicationId'] } as const;

/** The trust control-plane's CellAccountStack writes, as IAM returns it: the API statement, then the build's AssumeRole and TagSession statements. */
function pairTrust(half: 'cell' | 'tenant'): any {
  const keys = [...TAG_KEYS[half]];
  const required = Object.fromEntries(keys.map((k) => [`aws:RequestTag/${k}`, 'false']));
  const buildRole = { 'aws:PrincipalArn': `arn:aws:iam::${OTHER}:role/${FLEET}-${half}-build` };
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: `arn:aws:iam::${OTHER}:root` },
        Action: 'sts:AssumeRole',
        Condition: { ArnEquals: { 'aws:PrincipalArn': `arn:aws:iam::${OTHER}:role/${FLEET}-api` } },
      },
      {
        Effect: 'Allow',
        Principal: { AWS: `arn:aws:iam::${OTHER}:root` },
        Action: 'sts:AssumeRole',
        Condition: {
          'ArnEquals': buildRole,
          'Null': required,
          'ForAllValues:StringEquals': { 'aws:TagKeys': keys },
        },
      },
      {
        Effect: 'Allow',
        Principal: { AWS: `arn:aws:iam::${OTHER}:root` },
        Action: 'sts:TagSession',
        Condition: {
          'ArnEquals': buildRole,
          'Null': { ...required, 'sts:TransitiveTagKeys': 'false' },
          'ForAllValues:StringEquals': { 'aws:TagKeys': keys, 'sts:TransitiveTagKeys': keys },
        },
      },
    ],
  };
}

/** What the role pair stack gives each half: its owner policy and its SSM default policy. */
function pairPolicies(half: 'cell' | 'tenant'): Pick<RoleState, 'attached' | 'inline'> {
  const owner = half === 'cell' ? 'cell-build-policy' : 'cell-tenant-build-policy';
  const name = half === 'cell' ? 'RolesCellProvisioningRoleDefaultPolicy800A5565' : 'RolesTenantProvisioningRoleDefaultPolicy11629580';
  return {
    attached: [`arn:aws:iam::${ACCOUNT}:policy/${owner}`],
    inline: [{
      name,
      document: {
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Action: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
          Resource: `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/application-plane/shared/*`,
        }],
      },
    }],
  };
}

function healthy(): AccountState {
  return {
    accountId: ACCOUNT,
    partition: 'aws',
    stacks: [
      stack('CDKToolkit-cell'),
      stack(`${FLEET}-cell-account`),
      stack('CellPolicies', { tags: { 'stress:part': 'account-base' } }),
      stack('CellAccountBase', { tags: { 'stress:part': 'account-base' } }),
      stack('StressCell-01KAAAAAAAAAAAAAAAAAAAAAAA', { roleArn: EXEC, tags: { 'stress:part': 'cell' } }),
    ],
    roles: [
      role('StressCell-01KA-Ingress', '/cell/', { Service: 'lambda.amazonaws.com' }),
      role('StressCell-01KA-Runtime', '/cell/', { Service: 'bedrock-agentcore.amazonaws.com' }),
      role('StressCell-01KA-Tenant', '/cell/', { AWS: `arn:aws:iam::${ACCOUNT}:role/cell/StressCell-01KA-Ingress` }),
      role(`cdk-cell-deploy-role-${ACCOUNT}-${REGION}`, '/', { AWS: `arn:aws:iam::${ACCOUNT}:root` }),
    ],
    pair: {
      cell: { ...role(`${FLEET}-cell-provisioning`, '/'), trust: pairTrust('cell'), ...pairPolicies('cell') },
      tenant: { ...role(`${FLEET}-tenant-provisioning`, '/'), trust: pairTrust('tenant'), ...pairPolicies('tenant') },
    },
  };
}

const check = (s: AccountState, base = BASE): string[] => accountProblems(s, { fleet: FLEET, accountBaseStackArns: base, platformAccountId: OTHER });

describe('the cell account check (spec §3.7)', () => {
  it('passes an account with the cell bootstrap, the role pair, the listed account base and a cell', () => {
    expect(check(healthy())).toEqual([]);
  });

  it('refuses a stack of any other kind', () => {
    const s = healthy();
    expect(check({ ...s, stacks: [...s.stacks, stack('CellBoundaryProbe', { tags: { 'stress:part': 'cell-policy-probe' } })] })).toEqual([
      'stack CellBoundaryProbe (eu-central-1) is not a kind a cell account may hold (cell bootstrap, role pair, account base, cell)',
    ]);
  });

  it('refuses an account-base stack that is not on the owner\'s list, also one recreated under the same name', () => {
    const s = healthy();
    const recreated = s.stacks.map((st) => (st.name === 'CellPolicies' ? { ...st, arn: arn('CellPolicies', '00000000-0000-0000-0000-000000000002') } : st));
    expect(check({ ...s, stacks: recreated })).toEqual([
      "stack CellPolicies (eu-central-1) is tagged account-base but is not on the owner's list of account-base stack ARNs",
    ]);
  });

  it('refuses the same stack name in another Region', () => {
    const s = healthy();
    const elsewhere = stack('CellPolicies', { region: 'us-east-1', arn: `arn:aws:cloudformation:us-east-1:${ACCOUNT}:stack/CellPolicies/00000000-0000-0000-0000-000000000003`, tags: { 'stress:part': 'account-base' } });
    expect(check({ ...s, stacks: [...s.stacks, elsewhere] })).toHaveLength(1);
  });

  it('refuses a stack with a service role other than the cell execution role, whatever its name', () => {
    const s = healthy();
    const admin = `arn:aws:iam::${ACCOUNT}:role/Admin`;
    const stacks = s.stacks.map((st) => (st.name === 'CDKToolkit-cell' ? { ...st, roleArn: admin } : st));
    expect(check({ ...s, stacks })).toEqual(['stack CDKToolkit-cell (eu-central-1) has a service role other than the cell execution role']);
    const otherRegion = s.stacks.map((st) => (st.roleArn === EXEC ? { ...st, roleArn: EXEC.replace(REGION, 'us-east-1') } : st));
    expect(check({ ...s, stacks: otherRegion })).toHaveLength(1);
  });

  it('judges a nested stack by its root', () => {
    const s = healthy();
    const cell = s.stacks.find((st) => st.roleArn === EXEC)!;
    const nested = stack('StressCell-nested', { roleArn: EXEC, rootArn: cell.arn });
    expect(check({ ...s, stacks: [...s.stacks, nested] })).toEqual([]);
    const orphan = stack('Other-nested', { rootArn: arn('Other') });
    expect(check({ ...s, stacks: [...s.stacks, orphan] })).toEqual(['nested stack Other-nested (eu-central-1) belongs to a stack the check refuses']);
  });

  it('refuses an account without the cell bootstrap or the role pair', () => {
    const s = healthy();
    expect(check({ ...s, stacks: s.stacks.filter((st) => st.name !== 'CDKToolkit-cell') })).toEqual(['no CDKToolkit-cell stack: run bootstrap-cell.sh']);
    expect(check({ ...s, stacks: s.stacks.filter((st) => st.name !== `${FLEET}-cell-account`) })).toEqual([`no ${FLEET}-cell-account stack: run deploy-role-pair.sh`]);
    expect(check({ ...s, pair: { ...s.pair, tenant: undefined } })).toEqual(['the role pair has no tenant role']);
  });

  it('refuses a default CDK bootstrap role', () => {
    const s = healthy();
    expect(check({ ...s, roles: [...s.roles, role(`cdk-hnb659fds-deploy-role-${ACCOUNT}-${REGION}`, '/')] })).toEqual([
      `role cdk-hnb659fds-deploy-role-${ACCOUNT}-${REGION} belongs to a default CDK bootstrap, which a cell account must not hold`,
    ]);
  });

  it('refuses a role pair on /cell/ or under either cell boundary, with or without a suffix', () => {
    const s = healthy();
    expect(check({ ...s, pair: { ...s.pair, cell: { ...s.pair.cell!, path: '/cell/' } } })).toEqual([`role pair cell role ${FLEET}-cell-provisioning is on /cell/, not /`]);
    for (const b of ['cell-permissions-boundary', 'cell-workload-boundary-w10']) {
      const bounded = { ...s.pair.tenant!, boundaryArn: `arn:aws:iam::${ACCOUNT}:policy/${b}` };
      expect(check({ ...s, pair: { ...s.pair, tenant: bounded } })).toEqual([`role pair tenant role ${FLEET}-tenant-provisioning is under a cell boundary`]);
    }
    const otherBoundary = { ...s.pair.tenant!, boundaryArn: `arn:aws:iam::${ACCOUNT}:policy/owner-boundary` };
    expect(check({ ...s, pair: { ...s.pair, tenant: otherBoundary } })).toEqual([]);
  });

  it('refuses a managed or inline policy on the role pair outside its stack\'s set, and a missing owner policy', () => {
    const s = healthy();
    const admin = { ...s.pair.cell!, attached: [...s.pair.cell!.attached!, 'arn:aws:iam::aws:policy/AdministratorAccess'] };
    expect(check({ ...s, pair: { ...s.pair, cell: admin } })).toEqual([
      `role pair cell role ${FLEET}-cell-provisioning has a managed policy outside its stack's set (AdministratorAccess)`,
    ]);
    const none = { ...s.pair.tenant!, attached: [] };
    expect(check({ ...s, pair: { ...s.pair, tenant: none } })).toEqual([`role pair tenant role ${FLEET}-tenant-provisioning lacks cell-tenant-build-policy`]);
    const extra = { ...s.pair.cell!, inline: [...s.pair.cell!.inline!, { name: 'oops', document: { Statement: [] } }] };
    expect(check({ ...s, pair: { ...s.pair, cell: extra } })).toEqual([
      `role pair cell role ${FLEET}-cell-provisioning has an inline policy outside its stack's set (oops)`,
      `role pair cell role ${FLEET}-cell-provisioning has 2 inline policies, its stack makes one`,
    ]);
    const wide = { ...s.pair.cell!, inline: [{ name: 'RolesCellProvisioningRoleDefaultPolicy800A5565', document: { Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Resource: '*' }] } }] };
    expect(check({ ...s, pair: { ...s.pair, cell: wide } })).toEqual([
      `role pair cell role ${FLEET}-cell-provisioning: inline policy RolesCellProvisioningRoleDefaultPolicy800A5565 grants more than the SSM namespace actions`,
    ]);
  });

  it('refuses a role pair trust other than its stack\'s: another principal, a wider role list, an extra statement, a dropped condition', () => {
    const s = healthy();
    const wrong = `role pair cell role ${FLEET}-cell-provisioning has a trust policy other than its stack's`;
    const base = pairTrust('cell');
    const [api, assume, tag] = base.Statement;
    const variants: any[] = [
      // The API statement.
      { ...base, Statement: [{ ...api, Principal: { AWS: 'arn:aws:iam::333333333333:root' } }, assume, tag] },
      { ...base, Statement: [{ ...api, Principal: { AWS: '*' } }, assume, tag] },
      { ...base, Statement: [{ ...api, Principal: { AWS: api.Principal.AWS, Service: 'ec2.amazonaws.com' } }, assume, tag] },
      { ...base, Statement: [{ ...api, Condition: { ArnEquals: { 'aws:PrincipalArn': [api.Condition.ArnEquals['aws:PrincipalArn'], `arn:aws:iam::${OTHER}:role/admin`] } } }, assume, tag] },
      { ...base, Statement: [{ ...api, Condition: { ArnLike: { 'aws:PrincipalArn': `arn:aws:iam::${OTHER}:role/*` } } }, assume, tag] },
      { ...base, Statement: [{ ...api, Condition: undefined }, assume, tag] },
      // The API role may not pass tags (ADR-0051).
      { ...base, Statement: [{ ...api, Action: ['sts:AssumeRole', 'sts:TagSession'] }, assume, tag] },
      { ...base, Statement: [{ ...api, Condition: { ...api.Condition, StringEquals: { 'sts:ExternalId': 'x' } } }, assume, tag] },
      // The build AssumeRole statement: untagged, no key list, an extra key, TagSession folded in.
      { ...base, Statement: [api, { ...assume, Condition: { ArnEquals: assume.Condition.ArnEquals } }, tag] },
      { ...base, Statement: [api, { ...assume, Condition: { ...assume.Condition, Null: undefined } }, tag] },
      { ...base, Statement: [api, { ...assume, Condition: { ...assume.Condition, 'ForAllValues:StringEquals': undefined } }, tag] },
      { ...base, Statement: [api, { ...assume, Condition: { ...assume.Condition, 'ForAllValues:StringEquals': { 'aws:TagKeys': ['CellId', 'TenantId'] } } }, tag] },
      { ...base, Statement: [api, { ...assume, Action: ['sts:AssumeRole', 'sts:TagSession'] }, tag] },
      // The build TagSession statement: no transitive keys, an extra key, an extra action, the external id.
      { ...base, Statement: [api, assume, { ...tag, Condition: { ...tag.Condition, Null: { 'aws:RequestTag/CellId': 'false' } } }] },
      { ...base, Statement: [api, assume, { ...tag, Condition: { ...tag.Condition, 'ForAllValues:StringEquals': undefined } }] },
      { ...base, Statement: [api, assume, { ...tag, Condition: { ...tag.Condition, 'ForAllValues:StringEquals': { 'aws:TagKeys': ['CellId', 'TenantId'], 'sts:TransitiveTagKeys': ['CellId'] } } }] },
      { ...base, Statement: [api, assume, { ...tag, Action: ['sts:TagSession', 'sts:SetSourceIdentity'] }] },
      { ...base, Statement: [api, assume, { ...tag, Condition: { ...tag.Condition, StringEquals: { 'sts:ExternalId': 'x' } } }] },
      // A statement missing, or a fourth one.
      { ...base, Statement: [api] },
      { ...base, Statement: [api, assume] },
      { ...base, Statement: [api, tag] },
      { ...base, Statement: [assume, tag] },
      { ...base, Statement: [api, assume, tag, { Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::333333333333:root' }, Action: 'sts:AssumeRole' }] },
      { ...base, Statement: [api, api, tag] },
    ];
    for (const t of variants) {
      expect(check({ ...s, pair: { ...s.pair, cell: { ...s.pair.cell!, trust: t } } })).toEqual([wrong]);
    }
    // The tenant role names the tenant build role and the tenant tags, never the cell's.
    const swapped = { ...s.pair.tenant!, trust: pairTrust('cell') };
    expect(check({ ...s, pair: { ...s.pair, tenant: swapped } })).toEqual([`role pair tenant role ${FLEET}-tenant-provisioning has a trust policy other than its stack's`]);
    // IAM may return the principal as the bare account id, single values as lists, and statements in any order.
    const bare = { ...base, Statement: [{ ...tag, Principal: { AWS: OTHER } }, { ...assume, Principal: { AWS: OTHER } }, { ...api, Principal: { AWS: OTHER }, Action: ['sts:AssumeRole'] }] };
    expect(check({ ...s, pair: { ...s.pair, cell: { ...s.pair.cell!, trust: bare } } })).toEqual([]);
  });

  it('expects the owner policies with the suffix', () => {
    const s = healthy();
    expect(accountProblems(s, { fleet: FLEET, accountBaseStackArns: BASE, policySuffix: '-w10', platformAccountId: OTHER })).toEqual([
      `role pair cell role ${FLEET}-cell-provisioning has a managed policy outside its stack's set (cell-build-policy)`,
      `role pair cell role ${FLEET}-cell-provisioning lacks cell-build-policy-w10`,
      `role pair tenant role ${FLEET}-tenant-provisioning has a managed policy outside its stack's set (cell-tenant-build-policy)`,
      `role pair tenant role ${FLEET}-tenant-provisioning lacks cell-tenant-build-policy-w10`,
    ]);
  });

  it('refuses a /cell/ role trusted from another account, by a federated principal, by anyone, or by a service the cell does not use', () => {
    const s = healthy();
    const cases: [unknown, string][] = [
      [{ AWS: `arn:aws:iam::${OTHER}:root` }, 'AWS:another account'],
      [{ AWS: OTHER }, 'AWS:another account'],
      [{ Federated: 'cognito-identity.amazonaws.com' }, 'Federated:cognito-identity.amazonaws.com'],
      ['*', '*'],
      [{ AWS: '*' }, 'AWS:*'],
      [{ Service: 'ec2.amazonaws.com' }, 'Service:ec2.amazonaws.com'],
    ];
    for (const [principal, shown] of cases) {
      expect(check({ ...s, roles: [...s.roles, role('StressCell-x', '/cell/', principal)] })).toEqual([`role /cell/StressCell-x is trusted from outside the account (${shown})`]);
    }
    // A role outside /cell/ (the pair, the bootstrap) is the owner's and is not read here.
    expect(check({ ...s, roles: [...s.roles, role('owner', '/', { AWS: `arn:aws:iam::${OTHER}:root` })] })).toEqual([]);
  });
});

describe('outsidePrincipals', () => {
  it('reads every Allow statement, skips Deny, and refuses NotPrincipal', () => {
    const doc = {
      Statement: [
        { Effect: 'Deny', Principal: { AWS: `arn:aws:iam::${OTHER}:root` } },
        { Effect: 'Allow', Principal: { AWS: [`arn:aws:iam::${ACCOUNT}:role/cell/a`, `arn:aws:sts::${ACCOUNT}:assumed-role/x/y`] } },
        { Effect: 'Allow', NotPrincipal: { AWS: `arn:aws:iam::${ACCOUNT}:root` } },
      ],
    };
    expect(outsidePrincipals(doc, ACCOUNT, 'aws')).toEqual(['NotPrincipal']);
  });

  it('never prints another account id', () => {
    expect(outsidePrincipals(trust({ AWS: `arn:aws:iam::${OTHER}:role/x` }), ACCOUNT, 'aws').join(' ')).not.toContain(OTHER);
  });
});
