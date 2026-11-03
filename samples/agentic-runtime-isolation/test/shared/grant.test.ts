// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  AgentDefinition,
  compressTools,
  expandTools,
  grantFor,
  GrantInputs,
  MAX_SCOPE_BYTES,
  scopeGrantsTool,
  targetsOf,
  ToolCatalogue,
} from '../../src/shared/grant';

/** The grant rule (P-11, spec §3.6, ADR-0030, ADR-0032, ADR-0033). */
const catalogue: ToolCatalogue = new Map([
  ['crm', ['get_account', 'list_cases', 'update_case']],
  ['invoices', ['get_invoice']],
]);

const agent: AgentDefinition = { name: 'default', needs: ['default/chat'], tools: ['crm/*'] };

const inputs = (overrides: Partial<GrantInputs> = {}): GrantInputs => ({
  tenant: { status: 'active', agents: ['default'], tools: ['crm/*', 'invoices/*'] },
  agent,
  catalogue,
  ...overrides,
});

describe('expandTools / compressTools', () => {
  it('expands <target>/* to every catalogued tool and keeps only catalogued names', () => {
    expect([...expandTools(['crm/*', 'invoices/get_invoice', 'invoices/nope', 'unknown/*', 'bad', '/x', 'x/'], catalogue)].sort()).toEqual([
      'crm/get_account',
      'crm/list_cases',
      'crm/update_case',
      'invoices/get_invoice',
    ]);
  });

  it('compresses a complete target back to <target>/* and sorts', () => {
    const full = expandTools(['crm/*', 'invoices/*'], catalogue);
    expect(compressTools(full, catalogue)).toEqual(['crm/*', 'invoices/*']);
    expect(compressTools(new Set(['crm/update_case', 'crm/get_account']), catalogue)).toEqual(['crm/get_account', 'crm/update_case']);
  });

  it('targetsOf names the distinct targets, sorted', () => {
    expect(targetsOf(['invoices/*', 'crm/get_account', 'crm/*', 'bad'])).toEqual(['crm', 'invoices']);
  });
});

describe('grantFor', () => {
  it('grants the agent needs plus its tools the tenant holds, compressed', () => {
    const result = grantFor(inputs());
    expect(result).toEqual({ granted: true, entries: ['crm/*', 'default/chat'], scope: 'crm/* default/chat', noToolsGranted: false, toolTargets: ['crm'] });
  });

  it('a tool the agent does not name is never granted, even when the tenant holds it', () => {
    const result = grantFor(inputs());
    expect(result.granted && result.scope.includes('invoices')).toBe(false);
  });

  it('intersects with the tenant tools: a partial target stays named tool by tool', () => {
    const result = grantFor(inputs({ tenant: { status: 'active', agents: ['default'], tools: ['crm/get_account', 'crm/list_cases'] } }));
    expect(result).toMatchObject({ granted: true, entries: ['crm/get_account', 'crm/list_cases', 'default/chat'] });
  });

  it('a plan adds agents and tools to the tenant row', () => {
    const result = grantFor(inputs({
      tenant: { status: 'active', agents: [], tools: [] },
      plan: { agents: ['default'], tools: ['crm/get_account'] },
    }));
    expect(result).toMatchObject({ granted: true, scope: 'crm/get_account default/chat' });
  });

  it('the admin cut removes tools (expanded) and agents', () => {
    expect(grantFor(inputs({ cut: { cutAgents: [], cutTools: ['crm/update_case'] } }))).toMatchObject({
      granted: true,
      entries: ['crm/get_account', 'crm/list_cases', 'default/chat'],
    });
    expect(grantFor(inputs({ cut: { cutAgents: [], cutTools: ['crm/*'] } }))).toEqual({
      granted: true,
      entries: ['default/chat'],
      scope: 'default/chat',
      toolTargets: [],
      noToolsGranted: true,
    });
    expect(grantFor(inputs({ cut: { cutAgents: ['default'], cutTools: [] } }))).toEqual({ granted: false, reason: 'agent_not_subscribed' });
  });

  it('no tenant row, or an agent the tenant does not hold: agent_not_subscribed', () => {
    expect(grantFor(inputs({ tenant: undefined }))).toEqual({ granted: false, reason: 'agent_not_subscribed' });
    expect(grantFor(inputs({ tenant: { status: 'active', agents: ['billing'], tools: ['crm/*'] } }))).toEqual({ granted: false, reason: 'agent_not_subscribed' });
  });

  it('a suspended tenant is refused before anything else', () => {
    expect(grantFor(inputs({ tenant: { status: 'suspended', agents: ['default'], tools: [] } }))).toEqual({ granted: false, reason: 'tenant_suspended' });
  });

  it('needs are not expanded, compressed or intersected', () => {
    const result = grantFor(inputs({ agent: { name: 'default', needs: ['default/chat', 'default/*'], tools: [] }, tenant: { status: 'active', agents: ['default'], tools: [] } }));
    expect(result).toMatchObject({ granted: true, entries: ['default/*', 'default/chat'], noToolsGranted: true });
  });

  it(`refuses a scope over ${MAX_SCOPE_BYTES} bytes with grant_too_large`, () => {
    expect(MAX_SCOPE_BYTES).toBe(8192);
    const many = Array.from({ length: 300 }, (_, i) => `tool_${String(i).padStart(3, '0')}_${'x'.repeat(20)}`);
    const big: ToolCatalogue = new Map([['crm', [...many, 'extra']]]);
    const result = grantFor(inputs({
      catalogue: big,
      agent: { name: 'default', needs: [], tools: many.map((t) => `crm/${t}`) },
      tenant: { status: 'active', agents: ['default'], tools: many.map((t) => `crm/${t}`) },
    }));
    expect(result).toEqual({ granted: false, reason: 'grant_too_large' });
  });

  it('grants a scope between the old 4,096-byte and the new 8,192-byte bound (ADR-0041, V-16c)', () => {
    const many = Array.from({ length: 200 }, (_, i) => `tool_${String(i).padStart(3, '0')}_${'x'.repeat(20)}`);
    const big: ToolCatalogue = new Map([['crm', [...many, 'extra']]]);
    const result = grantFor(inputs({
      catalogue: big,
      agent: { name: 'default', needs: [], tools: many.map((t) => `crm/${t}`) },
      tenant: { status: 'active', agents: ['default'], tools: many.map((t) => `crm/${t}`) },
    }));
    expect(result).toMatchObject({ granted: true, toolTargets: ['crm'] });
    const bytes = Buffer.byteLength((result as { scope: string }).scope, 'utf8');
    expect(bytes).toBeGreaterThan(4096);
    expect(bytes).toBeLessThanOrEqual(MAX_SCOPE_BYTES);
  });

  it('toolTargets holds the targets of the granted tools only, never of the needs', () => {
    const result = grantFor(inputs({ agent: { name: 'default', needs: ['default/chat'], tools: [] }, tenant: { status: 'active', agents: ['default'], tools: ['crm/*'] } }));
    expect(result).toMatchObject({ granted: true, noToolsGranted: true, toolTargets: [] });
  });

  it('is deterministic: the same inputs in another order give the same scope string', () => {
    const a = grantFor(inputs({ tenant: { status: 'active', agents: ['default'], tools: ['crm/update_case', 'crm/get_account'] } }));
    const b = grantFor(inputs({ tenant: { status: 'active', agents: ['default'], tools: ['crm/get_account', 'crm/update_case'] } }));
    expect(a).toEqual(b);
  });
});

describe('scopeGrantsTool', () => {
  it('matches <target>/* or the tool as a whole entry', () => {
    expect(scopeGrantsTool('default/chat crm/*', 'crm/get_account')).toBe(true);
    expect(scopeGrantsTool('default/chat crm/get_account', 'crm/get_account')).toBe(true);
    expect(scopeGrantsTool('crm/get_account_extra', 'crm/get_account')).toBe(false);
    expect(scopeGrantsTool('xcrm/*', 'crm/get_account')).toBe(false);
    expect(scopeGrantsTool('invoices/*', 'crm/get_account')).toBe(false);
  });

  it('never grants a wildcard or a malformed name as the tool asked for', () => {
    expect(scopeGrantsTool('crm/*', 'crm/*')).toBe(false);
    expect(scopeGrantsTool('crm/*', 'crm')).toBe(false);
    expect(scopeGrantsTool('', 'crm/get_account')).toBe(false);
  });
});
