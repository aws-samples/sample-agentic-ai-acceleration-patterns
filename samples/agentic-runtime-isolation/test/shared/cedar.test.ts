// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { catalogueToolName, cedarPolicyFor, gatewayToolName, MAX_POLICY_STATEMENT_CHARS } from '../../src/shared/cedar';

/** The per-target star permit (spec §3.6, P-16, ADR-0034, ADR-0040, ADR-0041) in the shape spike V-16a proved ACTIVE. */
const GATEWAY_ARN = 'arn:aws:bedrock-agentcore:eu-central-1:111122223333:gateway/tools-abc';

/** Cedar `like`: `*` is any sequence, `\*` a literal star. */
function cedarLike(value: string, pattern: string): boolean {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '\\' && pattern[i + 1] === '*') {
      source += '\\*';
      i++;
    } else if (pattern[i] === '*') {
      source += '.*';
    } else {
      source += pattern[i].replace(/[.+?^${}()|[\]\\/-]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 's').test(value);
}

/** Evaluates the policy's `when` clause for one scope claim, reading only `==` and `like` on the scope tag. */
function permits(policy: string, scope: string): boolean {
  const clause = /principal\.hasTag\("scope"\) && \((.*)\)\n\};$/s.exec(policy)![1];
  return clause.split(' || ').some((alternative) => {
    const eq = /^principal\.getTag\("scope"\) == "(.*)"$/.exec(alternative);
    if (eq !== null) {
      return scope === eq[1];
    }
    const like = /^principal\.getTag\("scope"\) like "(.*)"$/.exec(alternative);
    if (like === null) {
      throw new Error(`unexpected alternative ${alternative}`);
    }
    return cedarLike(scope, like[1]);
  });
}

describe('cedarPolicyFor', () => {
  it('writes exactly one star permit for the target, in the V-16a shape', () => {
    const tag = 'principal.getTag("scope")';
    expect(cedarPolicyFor('invoices', GATEWAY_ARN)).toBe(
      [
        'permit(',
        '  principal is AgentCore::OAuthUser,',
        '  action in AgentCore::Action::"invoices",',
        `  resource == AgentCore::Gateway::"${GATEWAY_ARN}"`,
        ') when {',
        `  principal.hasTag("scope") && (${tag} == "invoices/*" || ${tag} like "invoices/\\* *" || ${tag} like "* invoices/\\*" || ${tag} like "* invoices/\\* *" || ${tag} like "invoices/*" || ${tag} like "* invoices/*")`,
        '};',
      ].join('\n'),
    );
  });

  it('names no tool: no per-tool action and no per-tool alternative, whatever the target holds', () => {
    const text = cedarPolicyFor('crm', GATEWAY_ARN);
    expect(text).not.toContain('___');
    expect(text).not.toContain('action ==');
    expect(text.match(/ \|\| /g)).toHaveLength(5);
    expect(text.length).toBeLessThan(MAX_POLICY_STATEMENT_CHARS / 10);
    // The longest target name stays far under the 10,000-character bound.
    expect(cedarPolicyFor('a'.repeat(32), GATEWAY_ARN).length).toBeLessThan(1000);
  });

  it('permits the target star or any tool of the target as a whole space-separated entry', () => {
    const text = cedarPolicyFor('crm', GATEWAY_ARN);
    for (const scope of ['crm/*', 'crm/* default/chat', 'default/chat crm/*', 'a/b crm/* default/chat', 'crm/get_account', 'default/chat crm/update_case', 'crm/get_account invoices/*']) {
      expect([scope, permits(text, scope)]).toEqual([scope, true]);
    }
  });

  it('refuses scopes that only name another target, including one whose name contains or extends this one', () => {
    const text = cedarPolicyFor('crm', GATEWAY_ARN);
    for (const scope of ['', 'invoices/*', 'xcrm/get_account', 'xcrm/*', 'crm-x/*', 'default/chat xcrm/a', 'default/crm/a', 'crm', 'default/chat crm']) {
      expect([scope, permits(text, scope)]).toEqual([scope, false]);
    }
  });

  it('refuses target names outside [a-z0-9-] before they reach the Cedar text', () => {
    for (const bad of ['CRM', 'crm"', 'crm*', 'crm/x', 'crm x', 'crm\\', '', 'a'.repeat(33), 'crm_x']) {
      expect(() => cedarPolicyFor(bad, GATEWAY_ARN)).toThrow(/target must match/);
    }
  });
});

describe('gatewayToolName / catalogueToolName', () => {
  it('round-trip <target>/<tool> through the Gateway name <target>___<tool>', () => {
    expect(gatewayToolName('crm', 'get_account')).toBe('crm___get_account');
    expect(catalogueToolName('crm___get_account')).toBe('crm/get_account');
    expect(catalogueToolName(gatewayToolName('my-target', 'a_b'))).toBe('my-target/a_b');
  });

  it('anything else is not a catalogue tool', () => {
    expect(catalogueToolName('crm__get_account')).toBeUndefined();
    expect(catalogueToolName('CRM___get_account')).toBeUndefined();
    expect(catalogueToolName('crm___')).toBeUndefined();
    expect(catalogueToolName('x-amz-bedrock-agentcore-search')).toBeUndefined();
  });
});
