// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Unit tests for the token-exchange service (spec §5.4, R-7, ADR-0009,
 * ADR-0012). Mocks the Cognito client with aws-sdk-client-mock and asserts:
 * ClientMetadata carries exactly the two §8.2 keys; the success shape;
 * each Cognito error mapping; and the ADR-0012 checks that reject a token
 * Cognito did not narrow (every one -> server_error with no token).
 */

import {
  CognitoIdentityProviderClient,
  GetTokensFromRefreshTokenCommand,
  InternalErrorException,
  InvalidParameterException,
  NotAuthorizedException,
  ResourceNotFoundException,
  TooManyRequestsException,
  UserLambdaValidationException,
} from '@aws-sdk/client-cognito-identity-provider';
import { AwsStub, mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import {
  COGNITO_USER_ADMIN_SCOPE,
  NARROW_SCOPE_KEY,
  NARROW_TENANT_KEY,
  TENANT_RESOURCE_PREFIX,
  TOKEN_TYPE_ACCESS,
  TOKEN_TYPE_REFRESH,
  GRANT_TYPE_TOKEN_EXCHANGE,
} from '../../src/shared/constants';
import { ScopeCatalogue, StaticScopeCatalogue } from '../../src/shared/scope-catalogue';

// The catalogue the exchange runs against (ADR-0034): two registered scopes.
const SCOPE_API_READ = 'sample/read';
const SCOPE_API_WRITE = 'sample/write';
const CATALOGUE = new StaticScopeCatalogue([SCOPE_API_READ, SCOPE_API_WRITE]);
import { OAuthError, OAuthServerError } from '../../src/smithy/token/typescript-ssdk-codegen/src';
import { TokenExchangeService } from '../../src/token-exchange/token-exchange';

const TENANT_A = '01HZX8K9P0QRST7VWXYZ1A2B3C';
const TENANT_B = '01HZX8K9P0QRST7VWXYZ1D4E5F';
const CLIENT = 'app-client-id';
const REFRESH = 'refresh-token-value';

// The SDK ships two copies of @smithy/types (one nested under
// @aws-sdk/types), so the command constructor's inferred types do not match
// the client's. The mock works at runtime; typing the stub as AwsStub<any>
// keeps the test readable without chasing the version skew. Assertions below
// still check concrete values.
const cognitoMock = mockClient(CognitoIdentityProviderClient as never) as unknown as AwsStub<
  any,
  any,
  any
>;
/** The command, cast past the duplicated @smithy/types for the mock API. */
const GetTokens = GetTokensFromRefreshTokenCommand as unknown as new (input: unknown) => any;

/** Build a fake unsigned JWT: base64url(header).base64url(payload).sig. */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.sig`;
}

/** A well-formed narrowed access token for tenant A with the given scopes. */
function narrowedToken(tenantId: string, scopes: string[]): string {
  return fakeJwt({ token_use: 'access', tenant_id: tenantId, scope: scopes.join(' '), sub: 'user-1' });
}

/** A form body (string) for the given overrides. */
function form(overrides: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    grant_type: GRANT_TYPE_TOKEN_EXCHANGE,
    client_id: CLIENT,
    subject_token: REFRESH,
    subject_token_type: TOKEN_TYPE_REFRESH,
    scope: SCOPE_API_READ,
    ...overrides,
  });
  return params.toString();
}

function service(): TokenExchangeService<Record<string, unknown>> {
  return new TokenExchangeService<Record<string, unknown>>({
    cognito: cognitoMock as unknown as CognitoIdentityProviderClient,
    acceptOtherClients: false,
    catalogue: CATALOGUE,
  });
}

/** Invoke ExchangeToken with a form body. */
async function exchange(body: string): Promise<ReturnType<TokenExchangeService<Record<string, unknown>>['ExchangeToken']>> {
  return service().ExchangeToken({ form: new TextEncoder().encode(body) }, {});
}

beforeEach(() => {
  cognitoMock.reset();
});

describe('ExchangeToken success (§5.4, ADR-0012)', () => {
  it('returns the narrowed token with the §5.4 success shape', async () => {
    cognitoMock.on(GetTokens).resolves({
      AuthenticationResult: { AccessToken: narrowedToken(TENANT_A, [SCOPE_API_READ]), ExpiresIn: 300 },
    });

    const output = await exchange(form({ resource: `${TENANT_RESOURCE_PREFIX}${TENANT_A}` }));

    expect(output.cacheControl).toBe('no-store');
    expect(output.accessToken).toBe(narrowedToken(TENANT_A, [SCOPE_API_READ]));
    expect(output.issuedTokenType).toBe(TOKEN_TYPE_ACCESS);
    expect(output.tokenType).toBe('Bearer');
    expect(output.expiresIn).toBe(300);
    expect(output.scope).toBe(SCOPE_API_READ);
  });

  it('sends ClientMetadata with exactly the two §8.2 keys when a tenant is requested', async () => {
    cognitoMock.on(GetTokens).resolves({
      AuthenticationResult: { AccessToken: narrowedToken(TENANT_A, [SCOPE_API_READ, SCOPE_API_WRITE]), ExpiresIn: 300 },
    });

    await exchange(form({ resource: `${TENANT_RESOURCE_PREFIX}${TENANT_A}`, scope: `${SCOPE_API_READ} ${SCOPE_API_WRITE}` }));

    const call = cognitoMock.commandCalls(GetTokens)[0];
    const input = call.args[0].input;
    expect(input.ClientId).toBe(CLIENT);
    expect(input.RefreshToken).toBe(REFRESH);
    expect(input.ClientMetadata).toEqual({
      [NARROW_TENANT_KEY]: TENANT_A,
      [NARROW_SCOPE_KEY]: `${SCOPE_API_READ} ${SCOPE_API_WRITE}`,
    });
    expect(Object.keys(input.ClientMetadata ?? {})).toHaveLength(2);
  });

  it('always sets the scope key even without a tenant (§5.4: always narrow)', async () => {
    cognitoMock.on(GetTokens).resolves({
      AuthenticationResult: { AccessToken: narrowedToken(TENANT_A, [SCOPE_API_READ]), ExpiresIn: 300 },
    });

    await exchange(form());

    const input = cognitoMock.commandCalls(GetTokens)[0].args[0].input;
    expect(input.ClientMetadata).toEqual({ [NARROW_SCOPE_KEY]: SCOPE_API_READ });
    expect(input.ClientMetadata?.[NARROW_TENANT_KEY]).toBeUndefined();
  });

  it('matches the token scope set order-insensitively (ADR-0012)', async () => {
    cognitoMock.on(GetTokens).resolves({
      // Token lists scopes in a different order than requested.
      AuthenticationResult: { AccessToken: narrowedToken(TENANT_A, [SCOPE_API_WRITE, SCOPE_API_READ]), ExpiresIn: 300 },
    });

    const output = await exchange(form({ scope: `${SCOPE_API_READ} ${SCOPE_API_WRITE}` }));
    expect(output.scope).toBe(`${SCOPE_API_READ} ${SCOPE_API_WRITE}`);
  });
});

describe('ExchangeToken Cognito error mapping (§5.4)', () => {
  const meta = { $metadata: {} };

  it('invalid_target in the lambda message -> invalid_target (400)', async () => {
    cognitoMock.on(GetTokens).rejects(
      new UserLambdaValidationException({ message: 'PreTokenGeneration failed with error invalid_target: tenant not held', $metadata: {} }),
    );
    await expect(exchange(form({ resource: `${TENANT_RESOURCE_PREFIX}${TENANT_A}` }))).rejects.toMatchObject({
      name: 'OAuthError',
      code: 'invalid_target',
    });
  });

  it('an inactive tenant (trigger status refusal) -> invalid_target, not invalid_grant (§5.4)', async () => {
    cognitoMock.on(GetTokens).rejects(
      new UserLambdaValidationException({ message: 'PreTokenGeneration failed with error invalid_target: tenant is not active', $metadata: {} }),
    );
    await expect(exchange(form())).rejects.toMatchObject({ name: 'OAuthError', code: 'invalid_target' });
  });

  it('invalid_scope in the lambda message -> invalid_scope (400)', async () => {
    cognitoMock.on(GetTokens).rejects(
      new UserLambdaValidationException({ message: 'PreTokenGeneration failed with error invalid_scope: not held', $metadata: {} }),
    );
    await expect(exchange(form())).rejects.toMatchObject({ name: 'OAuthError', code: 'invalid_scope' });
  });

  it('the invalid_target/invalid_scope prefix routes only on UserLambdaValidationException (§5.4)', async () => {
    // Another exception whose text happens to carry the prefix is not a
    // trigger verdict: NotAuthorizedException stays invalid_grant.
    cognitoMock.on(GetTokens).rejects(
      new NotAuthorizedException({ message: 'Refresh token invalid_target: echoed text', $metadata: {} }),
    );
    await expect(exchange(form())).rejects.toMatchObject({ name: 'OAuthError', code: 'invalid_grant' });
    cognitoMock.on(GetTokens).rejects(
      new TooManyRequestsException({ message: 'invalid_scope in a throttling message', $metadata: {} }),
    );
    await expect(exchange(form())).rejects.toMatchObject({ name: 'OAuthServerError', code: 'server_error' });
  });

  it('spec §5.4: an unprefixed UserLambdaValidationException (trigger fault) -> server_error, not invalid_grant', async () => {
    // Neither the invalid_target nor the invalid_scope prefix: the trigger
    // failed for a non-caller reason (e.g. a registry outage). The client
    // must retry, not discard its refresh token.
    cognitoMock.on(GetTokens).rejects(
      new UserLambdaValidationException({ message: 'PreTokenGeneration failed with error AccessDeniedException', $metadata: {} }),
    );
    const caught = await exchange(form()).catch((e) => e);
    expect(caught).toBeInstanceOf(OAuthServerError);
    expect(caught.code).toBe('server_error');
    expect(caught.description).toMatch(/retry later/);
  });

  it.each([
    ['NotAuthorizedException', new NotAuthorizedException({ message: 'x', ...meta })],
    ['InvalidParameterException', new InvalidParameterException({ message: 'x', ...meta })],
    ['ResourceNotFoundException', new ResourceNotFoundException({ message: 'x', ...meta })],
  ])('%s -> invalid_grant (400)', async (_name, error) => {
    cognitoMock.on(GetTokens).rejects(error);
    const caught = await exchange(form()).catch((e) => e);
    expect(caught).toBeInstanceOf(OAuthError);
    expect(caught.code).toBe('invalid_grant');
  });

  it.each([
    ['TooManyRequestsException', new TooManyRequestsException({ message: 'x', ...meta })],
    ['InternalErrorException', new InternalErrorException({ message: 'x', ...meta })],
  ])('%s -> server_error (500)', async (_name, error) => {
    cognitoMock.on(GetTokens).rejects(error);
    const caught = await exchange(form()).catch((e) => e);
    expect(caught).toBeInstanceOf(OAuthServerError);
    expect(caught.code).toBe('server_error');
    // Retryable text, not the token-mismatch text.
    expect(caught.description).toMatch(/retry later/);
  });

  it('a generic 5xx fault -> server_error (500)', async () => {
    const err = Object.assign(new Error('boom'), { name: 'SomeFault', $metadata: { httpStatusCode: 503 } });
    cognitoMock.on(GetTokens).rejects(err);
    const caught = await exchange(form()).catch((e) => e);
    expect(caught).toBeInstanceOf(OAuthServerError);
    expect(caught.code).toBe('server_error');
  });
});

describe('ExchangeToken ADR-0012: reject tokens Cognito did not narrow', () => {
  async function expectServerErrorNoToken(accessToken: string, overrides: Record<string, string> = {}): Promise<void> {
    cognitoMock.on(GetTokens).resolves({
      AuthenticationResult: { AccessToken: accessToken, ExpiresIn: 300 },
    });
    const caught = await exchange(form({ resource: `${TENANT_RESOURCE_PREFIX}${TENANT_A}`, ...overrides })).catch((e) => e);
    expect(caught).toBeInstanceOf(OAuthServerError);
    expect(caught.code).toBe('server_error');
    // No token is returned on a mismatch, and the text is the mismatch text.
    expect(caught.accessToken).toBeUndefined();
    expect(caught.description).toMatch(/does not match the request/);
  }

  it('un-narrowed token with a tenants claim -> server_error', async () => {
    await expectServerErrorNoToken(
      fakeJwt({ token_use: 'access', tenants: [TENANT_A, TENANT_B], scope: SCOPE_API_READ }),
    );
  });

  it('token naming another tenant -> server_error', async () => {
    await expectServerErrorNoToken(fakeJwt({ token_use: 'access', tenant_id: TENANT_B, scope: SCOPE_API_READ }));
  });

  it('extra Cognito admin scope -> server_error', async () => {
    await expectServerErrorNoToken(
      fakeJwt({ token_use: 'access', tenant_id: TENANT_A, scope: `${SCOPE_API_READ} ${COGNITO_USER_ADMIN_SCOPE}` }),
    );
  });

  it('missing a requested scope -> server_error', async () => {
    await expectServerErrorNoToken(
      fakeJwt({ token_use: 'access', tenant_id: TENANT_A, scope: SCOPE_API_READ }),
      { scope: `${SCOPE_API_READ} ${SCOPE_API_WRITE}` },
    );
  });

  it('an id token (token_use=id) instead of access -> server_error', async () => {
    await expectServerErrorNoToken(fakeJwt({ token_use: 'id', tenant_id: TENANT_A, scope: SCOPE_API_READ }));
  });

  it('no AuthenticationResult from Cognito -> server_error', async () => {
    cognitoMock.on(GetTokens).resolves({});
    const caught = await exchange(form()).catch((e) => e);
    expect(caught).toBeInstanceOf(OAuthServerError);
    expect(caught.code).toBe('server_error');
  });
});

describe('ExchangeToken reads the catalogue only for a well-formed form (ADR-0034)', () => {
  /** A counting catalogue, so the read can be asserted on. */
  function countingCatalogue(names: string[]): ScopeCatalogue & { reads: number } {
    const c = {
      reads: 0,
      names: async () => {
        c.reads += 1;
        return new Set(names);
      },
    };
    return c;
  }
  function serviceWith(catalogue: ScopeCatalogue): TokenExchangeService<Record<string, unknown>> {
    return new TokenExchangeService<Record<string, unknown>>({
      cognito: cognitoMock as unknown as CognitoIdentityProviderClient,
      acceptOtherClients: false,
      catalogue,
    });
  }

  it('a malformed form is refused before the catalogue is consulted', async () => {
    const catalogue = countingCatalogue([SCOPE_API_READ]);
    for (const body of [form({ grant_type: 'authorization_code' }), form({ scope: 'Sample/Read' }), form({ subject_token: '' })]) {
      await expect(serviceWith(catalogue).ExchangeToken({ form: new TextEncoder().encode(body) }, {})).rejects.toBeInstanceOf(OAuthError);
    }
    expect(catalogue.reads).toBe(0);
    expect(cognitoMock.commandCalls(GetTokens)).toHaveLength(0);
  });

  it('a well-formed form reads the catalogue once; an unregistered scope -> invalid_scope, no Cognito call', async () => {
    const catalogue = countingCatalogue([SCOPE_API_READ]);
    const caught = await serviceWith(catalogue)
      .ExchangeToken({ form: new TextEncoder().encode(form({ scope: 'billing/read' })) }, {})
      .catch((e) => e);
    expect(caught).toBeInstanceOf(OAuthError);
    expect(caught.code).toBe('invalid_scope');
    expect(catalogue.reads).toBe(1);
    expect(cognitoMock.commandCalls(GetTokens)).toHaveLength(0);
  });
});

describe('ExchangeToken T-28: shared-pool client_id check', () => {
  /** A service bound to a shared-pool app client id, in a single shared topology. */
  function serviceWith(appClientId: string, acceptOtherClients = false): TokenExchangeService<Record<string, unknown>> {
    return new TokenExchangeService<Record<string, unknown>>({
      cognito: cognitoMock as unknown as CognitoIdentityProviderClient,
      appClientId,
      acceptOtherClients,
      catalogue: CATALOGUE,
    });
  }

  it('a client_id other than the shared app client -> invalid_client, no Cognito call', async () => {
    const caught = await serviceWith('the-only-client')
      .ExchangeToken({ form: new TextEncoder().encode(form({ client_id: 'some-other-client' })) }, {})
      .catch((e) => e);
    expect(caught).toBeInstanceOf(OAuthError);
    expect(caught.code).toBe('invalid_client');
    // Refused before the refresh token ever reaches Cognito.
    expect(cognitoMock.commandCalls(GetTokens)).toHaveLength(0);
  });

  it('the matching client_id passes the check and calls Cognito', async () => {
    cognitoMock.on(GetTokens).resolves({
      AuthenticationResult: { AccessToken: narrowedToken(TENANT_A, [SCOPE_API_READ]), ExpiresIn: 300 },
    });
    const output = await serviceWith(CLIENT).ExchangeToken(
      { form: new TextEncoder().encode(form()) },
      {},
    );
    expect(output.accessToken).toBe(narrowedToken(TENANT_A, [SCOPE_API_READ]));
    expect(cognitoMock.commandCalls(GetTokens)).toHaveLength(1);
  });

  it('appClientId undefined (pool-per-tenant) performs no check', async () => {
    cognitoMock.on(GetTokens).resolves({
      AuthenticationResult: { AccessToken: narrowedToken(TENANT_A, [SCOPE_API_READ]), ExpiresIn: 300 },
    });
    // The default `service()` passes no appClientId; any client_id is allowed.
    await exchange(form({ client_id: 'any-tenant-client' }));
    expect(cognitoMock.commandCalls(GetTokens)).toHaveLength(1);
  });

  describe('tiered: acceptOtherClients (ADR-0027)', () => {
    it('a premium tenant\'s client passes next to the shared client and reaches Cognito', async () => {
      cognitoMock.on(GetTokens).resolves({
        AuthenticationResult: { AccessToken: narrowedToken(TENANT_B, [SCOPE_API_READ]), ExpiresIn: 300 },
      });
      const output = await serviceWith('the-shared-client', true).ExchangeToken(
        { form: new TextEncoder().encode(form({ client_id: 'premium-tenant-client', resource: `${TENANT_RESOURCE_PREFIX}${TENANT_B}` })) },
        {},
      );
      expect(output.accessToken).toBe(narrowedToken(TENANT_B, [SCOPE_API_READ]));
      const input = cognitoMock.commandCalls(GetTokens)[0].args[0].input;
      expect(input.ClientId).toBe('premium-tenant-client');
    });

    it('the shared client still passes', async () => {
      cognitoMock.on(GetTokens).resolves({
        AuthenticationResult: { AccessToken: narrowedToken(TENANT_A, [SCOPE_API_READ]), ExpiresIn: 300 },
      });
      await serviceWith(CLIENT, true).ExchangeToken({ form: new TextEncoder().encode(form()) }, {});
      expect(cognitoMock.commandCalls(GetTokens)).toHaveLength(1);
    });

    it('a foreign client is refused by the trigger, not here: invalid_target surfaces as the OAuth error', async () => {
      // The client belongs to a pool the registry does not know (M-5): the
      // trigger throws invalid_target, which Cognito wraps and this maps.
      cognitoMock
        .on(GetTokens)
        .rejects(
          new UserLambdaValidationException({
            message: 'PreTokenGeneration failed with error invalid_target: unknown user pool.',
            $metadata: {},
          }),
        );
      const caught = await serviceWith(CLIENT, true)
        .ExchangeToken({ form: new TextEncoder().encode(form({ client_id: 'foreign-client' })) }, {})
        .catch((e) => e);
      expect(caught).toBeInstanceOf(OAuthError);
      expect(caught.code).toBe('invalid_target');
      expect(cognitoMock.commandCalls(GetTokens)).toHaveLength(1);
    });

    it('without acceptOtherClients the same form is still invalid_client (shared-pool unchanged)', async () => {
      const caught = await serviceWith(CLIENT, false)
        .ExchangeToken({ form: new TextEncoder().encode(form({ client_id: 'premium-tenant-client' })) }, {})
        .catch((e) => e);
      expect(caught.code).toBe('invalid_client');
      expect(cognitoMock.commandCalls(GetTokens)).toHaveLength(0);
    });
  });
});
