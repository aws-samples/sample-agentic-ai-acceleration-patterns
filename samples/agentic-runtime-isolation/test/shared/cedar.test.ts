// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { catalogueToolName, cedarPolicyFor, gatewayToolName } from '../../src/shared/cedar';

/** The per-target Cedar policy (spec §3.6, P-16, ADR-0034, ADR-0040) in the shape spike V-9 proved ACTIVE. */
const GATEWAY_ARN = 'arn:aws:bedrock-agentcore:eu-central-1:111122223333:gateway/tools-abc';

describe('cedarPolicyFor', () => {
  it('writes exactly the spike shape for one target', () => {
    const tag = 'principal.getTag("scope")';
    const match = (literal: string, pattern: string) =>
      `(${tag} == "${literal}" || ${tag} like "${pattern} *" || ${tag} like "* ${pattern}" || ${tag} like "* ${pattern} *")`;
    expect(cedarPolicyFor('invoices', ['get_invoice'], GATEWAY_ARN)).toBe(
      [
        'permit(',
        '  principal is AgentCore::OAuthUser,',
        '  action in [AgentCore::Action::"invoices___get_invoice"],',
        `  resource == AgentCore::Gateway::"${GATEWAY_ARN}"`,
        ') when {',
        `  principal.hasTag("scope") && (${match('invoices/*', 'invoices/\\*')} || (action == AgentCore::Action::"invoices___get_invoice" && ${match('invoices/get_invoice', 'invoices/get_invoice')}))`,
        '};',
      ].join('\n'),
    );
  });

  it('escapes * inside like but not in ==, and lists every tool as an action', () => {
    const text = cedarPolicyFor('crm', ['get_account', 'list_cases', 'update_case'], GATEWAY_ARN);
    expect(text).toContain('== "crm/*"');
    expect(text).toContain('like "crm/\\* *"');
    expect(text).not.toContain('like "crm/* *"');
    expect(text).toContain('action in [AgentCore::Action::"crm___get_account", AgentCore::Action::"crm___list_cases", AgentCore::Action::"crm___update_case"]');
    expect(text.match(/action == /g)).toHaveLength(3);
  });

  it('refuses names that could reach the Cedar text unchecked', () => {
    expect(() => cedarPolicyFor('CRM', ['x'], GATEWAY_ARN)).toThrow(/target must match/);
    expect(() => cedarPolicyFor('crm"', ['x'], GATEWAY_ARN)).toThrow(/target must match/);
    expect(() => cedarPolicyFor('crm', [], GATEWAY_ARN)).toThrow(/at least one tool/);
    expect(() => cedarPolicyFor('crm', ['get"account'], GATEWAY_ARN)).toThrow(/tool must match/);
    expect(() => cedarPolicyFor('crm', ['*'], GATEWAY_ARN)).toThrow(/tool must match/);
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
