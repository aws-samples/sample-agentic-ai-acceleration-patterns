// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Unit tests for the RFC 8693 form parser (spec §5.4, ADR-0011). Covers
 * every row of the §5.4 parameter table and the §5.4 error table, repeated
 * parameters (RFC 6749 §3.2), unknown parameters, and both string and
 * Uint8Array bodies. Asserts fixed descriptions never echo input.
 */

import {
  ALL_SCOPES,
  GRANT_TYPE_TOKEN_EXCHANGE,
  SCOPE_API_READ,
  SCOPE_API_WRITE,
  SCOPE_TENANT_ADMIN,
  TENANT_RESOURCE_PREFIX,
  TOKEN_TYPE_ACCESS,
  TOKEN_TYPE_REFRESH,
} from '../../src/shared/constants';
import {
  ExchangeRequest,
  OAUTH_ERROR_DESCRIPTIONS,
  OAuthFailure,
  parseExchangeForm,
} from '../../src/token-exchange/form';

const TENANT_A = '01HZX8K9P0QRST7VWXYZ1A2B3C';
const REFRESH = 'a-refresh-token-value';
const CLIENT = 'app-client-id';

/** Build a well-formed form with overrides; a value of `null` omits the key. */
function form(overrides: Record<string, string | null> = {}): string {
  const base: Record<string, string | null> = {
    grant_type: GRANT_TYPE_TOKEN_EXCHANGE,
    client_id: CLIENT,
    subject_token: REFRESH,
    subject_token_type: TOKEN_TYPE_REFRESH,
    scope: SCOPE_API_READ,
  };
  const merged = { ...base, ...overrides };
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) {
    if (v !== null) {
      params.append(k, v);
    }
  }
  return params.toString();
}

/** Assert that parsing throws OAuthFailure with a specific code. */
function expectCode(body: string | Uint8Array, code: string): OAuthFailure {
  try {
    parseExchangeForm(body);
  } catch (error) {
    expect(error).toBeInstanceOf(OAuthFailure);
    const failure = error as OAuthFailure;
    expect(failure.code).toBe(code);
    return failure;
  }
  throw new Error(`expected parse to throw ${code}`);
}

describe('parseExchangeForm §5.4 happy path', () => {
  it('parses a minimal valid form (string body)', () => {
    const result: ExchangeRequest = parseExchangeForm(form());
    expect(result).toEqual({ clientId: CLIENT, refreshToken: REFRESH, scopes: [SCOPE_API_READ] });
    expect(result.tenantId).toBeUndefined();
  });

  it('parses a Uint8Array body identically (§5.4, ADR-0011 blob payload)', () => {
    const bytes = new TextEncoder().encode(form());
    expect(parseExchangeForm(bytes)).toEqual({
      clientId: CLIENT,
      refreshToken: REFRESH,
      scopes: [SCOPE_API_READ],
    });
  });

  it('accepts resource = prefix + ULID and extracts tenantId (§5.4 resource)', () => {
    const result = parseExchangeForm(form({ resource: `${TENANT_RESOURCE_PREFIX}${TENANT_A}` }));
    expect(result.tenantId).toBe(TENANT_A);
  });

  it('accepts requested_token_type = access_token (§5.4 requested_token_type)', () => {
    expect(() => parseExchangeForm(form({ requested_token_type: TOKEN_TYPE_ACCESS }))).not.toThrow();
  });

  it('accepts multiple space-separated scopes from §8.1 (no duplicates)', () => {
    const result = parseExchangeForm(form({ scope: `${SCOPE_API_READ} ${SCOPE_API_WRITE} ${SCOPE_TENANT_ADMIN}` }));
    expect(result.scopes).toEqual([SCOPE_API_READ, SCOPE_API_WRITE, SCOPE_TENANT_ADMIN]);
    expect(ALL_SCOPES).toEqual(expect.arrayContaining(result.scopes));
  });
});

describe('parseExchangeForm §5.4 grant_type', () => {
  it('missing grant_type -> invalid_request', () => {
    expectCode(form({ grant_type: null }), 'invalid_request');
  });

  it('wrong grant_type -> unsupported_grant_type', () => {
    expectCode(form({ grant_type: 'authorization_code' }), 'unsupported_grant_type');
  });
});

describe('parseExchangeForm §5.4 required parameters', () => {
  it('missing client_id -> invalid_request', () => {
    expectCode(form({ client_id: null }), 'invalid_request');
  });

  it('empty client_id -> invalid_request', () => {
    expectCode(form({ client_id: '' }), 'invalid_request');
  });

  it('missing subject_token -> invalid_request', () => {
    expectCode(form({ subject_token: null }), 'invalid_request');
  });

  it('empty subject_token -> invalid_request', () => {
    expectCode(form({ subject_token: '' }), 'invalid_request');
  });
});

describe('parseExchangeForm §5.4 subject_token_type', () => {
  it('missing subject_token_type -> invalid_request', () => {
    expectCode(form({ subject_token_type: null }), 'invalid_request');
  });

  it('subject_token_type = access token (§10 step 7) -> invalid_request', () => {
    expectCode(form({ subject_token_type: TOKEN_TYPE_ACCESS }), 'invalid_request');
  });
});

describe('parseExchangeForm §5.4 requested_token_type', () => {
  it('requested_token_type = refresh token -> invalid_request', () => {
    expectCode(form({ requested_token_type: TOKEN_TYPE_REFRESH }), 'invalid_request');
  });
});

describe('parseExchangeForm §5.4 resource', () => {
  it('resource without the tenant prefix -> invalid_request', () => {
    expectCode(form({ resource: `urn:example:${TENANT_A}` }), 'invalid_request');
  });

  it('resource prefix with a non-ULID -> invalid_request', () => {
    expectCode(form({ resource: `${TENANT_RESOURCE_PREFIX}not-a-ulid` }), 'invalid_request');
  });

  it('repeated resource -> invalid_request (at most one, §5.4)', () => {
    const body = `${form()}&resource=${encodeURIComponent(TENANT_RESOURCE_PREFIX + TENANT_A)}&resource=${encodeURIComponent(TENANT_RESOURCE_PREFIX + TENANT_A)}`;
    expectCode(body, 'invalid_request');
  });
});

describe('parseExchangeForm §5.4 scope', () => {
  it('missing scope -> invalid_request', () => {
    expectCode(form({ scope: null }), 'invalid_request');
  });

  it('empty scope -> invalid_request', () => {
    expectCode(form({ scope: '' }), 'invalid_request');
  });

  it('whitespace-only scope -> invalid_request', () => {
    expectCode(form({ scope: '   ' }), 'invalid_request');
  });

  it('out-of-vocabulary scope (tenant-api/admin, §10 step 7) -> invalid_scope', () => {
    expectCode(form({ scope: 'tenant-api/admin' }), 'invalid_scope');
  });

  it('duplicate scope -> invalid_request', () => {
    expectCode(form({ scope: `${SCOPE_API_READ} ${SCOPE_API_READ}` }), 'invalid_request');
  });
});

describe('parseExchangeForm §5.4 refused and unknown parameters', () => {
  it.each(['audience', 'actor_token', 'actor_token_type'])(
    'refused RFC 8693 parameter %s -> invalid_request',
    (param) => {
      expectCode(form({ [param]: 'x' }), 'invalid_request');
    },
  );

  it('unknown parameter -> invalid_request (spec §10: rejects every RFC 8693 parameter not listed)', () => {
    expectCode(form({ requested_subject: 'x' }), 'invalid_request');
  });

  it('another unknown parameter -> invalid_request', () => {
    expectCode(form({ foo: 'bar' }), 'invalid_request');
  });
});

describe('parseExchangeForm RFC 6749 §3.2 repeated parameters', () => {
  it.each(['grant_type', 'client_id', 'subject_token', 'subject_token_type', 'scope'])(
    'repeated %s -> invalid_request',
    (param) => {
      const body = `${form()}&${param}=duplicate`;
      expectCode(body, 'invalid_request');
    },
  );
});

describe('OAuthFailure descriptions (§5.4: fixed text, never echo input)', () => {
  it('a failure description never contains the submitted values', () => {
    const failure = expectCode(form({ grant_type: 'secret-grant', client_id: 'secret-client' }), 'unsupported_grant_type');
    expect(failure.description).toBe(OAUTH_ERROR_DESCRIPTIONS.unsupported_grant_type);
    expect(failure.description).not.toContain('secret-grant');
    expect(failure.description).not.toContain('secret-client');
  });

  it('every code has fixed description text', () => {
    for (const code of Object.keys(OAUTH_ERROR_DESCRIPTIONS)) {
      expect(OAUTH_ERROR_DESCRIPTIONS[code as keyof typeof OAUTH_ERROR_DESCRIPTIONS]).toBeTruthy();
    }
  });
});
