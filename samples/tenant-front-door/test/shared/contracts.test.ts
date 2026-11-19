// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { paramTenantNamespace, ROUTER_TOKENS, substituteRouterTokens } from '../../src/shared/contracts';

const values = {
  appDomain: 'app.example.com',
  addressing: 'single',
  tenantClaim: 'it\'s "tenant_id"',
  agentIngress: 'off',
  reservedLabels: 'www,api',
};

const source = Object.entries(ROUTER_TOKENS)
  .map(([name, token]) => `const ${name} = "${token}";`)
  .join('\n');

describe('substituteRouterTokens', () => {
  test('replaces each quoted literal with the JSON-encoded value', () => {
    const out = substituteRouterTokens(source, values);
    expect(out).toContain('const appDomain = "app.example.com";');
    // eslint-disable-next-line no-new-func
    const read = new Function(`${out}\nreturn tenantClaim;`) as () => string;
    expect(read()).toBe('it\'s "tenant_id"');
    expect(out).not.toContain('__TFD_');
  });

  test('refuses a source without one of the tokens', () => {
    expect(() => substituteRouterTokens(source.replace(`"${ROUTER_TOKENS.agentIngress}"`, '"off"'), values)).toThrow(
      /__TFD_AGENT_INGRESS__/,
    );
  });

  test('refuses a token left over in another form', () => {
    expect(() => substituteRouterTokens(`${source}\nconst x = '__TFD_APP_DOMAIN__';`, values)).toThrow(/unknown __TFD_/);
  });
});

describe('paramTenantNamespace', () => {
  test('uses the upper-case control-plane id', () => {
    expect(paramTenantNamespace('01hzx8k9p0qrst7vwxyz1a2b3c', 'demo')).toBe(
      '/application-plane/tenants/01HZX8K9P0QRST7VWXYZ1A2B3C/demo/',
    );
  });
});
