// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  CALL_TIMEOUT_MS,
  createHandler,
  handleEvent,
  isApiGatewayHost,
  OWNER_MAX_LENGTH,
  ownerMarker,
  ownerProblem,
  physicalId,
  type PlatformMethod,
  type PlatformResponse,
  respond,
  type ScopeRegistrationEvent,
  type ScopeRegistrationOutcome,
  scopeUrl,
  signedPlatformCall,
  unclaimedId,
} from '../../src/shared/scope-registration.function';

/** The scope-registration custom resource handler (ADR-0025): GET then PUT on Create/Update, GET then DELETE on Delete, SigV4 to tenant-identity's platform API. */
describe('scope-registration custom resource handler', () => {
  const API = 'https://abc123.execute-api.eu-central-1.amazonaws.com/prod/';
  const REGION = 'eu-central-1';
  const STACK = 'arn:aws:cloudformation:eu-central-1:111122223333:stack/Backend/1';
  const MARKER = `${STACK}#BillingScopes`;
  const OTHER_MARKER = 'arn:aws:cloudformation:eu-central-1:111122223333:stack/Other/2#BillingScopes';
  let calls: { method: string; url: string; body?: string }[];
  let logs: string[];
  let outSpy: jest.SpyInstance;

  /** The catalogue body GetScope answers for a scope with the given description. */
  const scopeBody = (name: string, description?: string) => JSON.stringify({ scope: { name, owner: name.split('/')[0], description, createdAt: '2026-10-29T00:00:00Z' } });

  interface StubOptions {
    /** A fixed status per method (default GET 404, PUT 200, DELETE 204). */
    status?: Partial<Record<PlatformMethod, number>>;
    /** Throw for a URL that matches (any method unless `failMethod` narrows it). */
    failOn?: RegExp;
    failMethod?: PlatformMethod;
    /** What the catalogue holds: scope name -> description (GET answers 200 with it). */
    catalogue?: Record<string, string | undefined>;
    /** GET answers 200 with this raw body instead of a catalogue entry. */
    rawBody?: string;
  }
  /** A platform stub: GET answers from `catalogue` (404 otherwise), PUT/DELETE a fixed status, or throws for a URL that matches `failOn`. */
  const deps = (options: StubOptions = {}) => ({
    region: REGION,
    call: async (method: PlatformMethod, url: URL, body?: string): Promise<PlatformResponse> => {
      calls.push({ method, url: url.toString(), body });
      const failsMethod = options.failMethod === undefined || options.failMethod === method;
      if (options.failOn !== undefined && options.failOn.test(url.toString()) && failsMethod) {
        throw new TypeError('fetch failed');
      }
      if (method === 'GET') {
        if (options.status?.GET !== undefined) {
          return { status: options.status.GET, body: '' };
        }
        if (options.rawBody !== undefined) {
          return { status: 200, body: options.rawBody };
        }
        const name = decodeURIComponent(url.pathname.split('/platform/scopes/')[1]);
        if (options.catalogue !== undefined && name in options.catalogue) {
          return { status: 200, body: scopeBody(name, options.catalogue[name]) };
        }
        return { status: 404, body: '{"message":"not found"}' };
      }
      return { status: options.status?.[method] ?? (method === 'PUT' ? 200 : 204) };
    },
  });

  const event = (
    type: ScopeRegistrationEvent['RequestType'],
    overrides: Partial<ScopeRegistrationEvent['ResourceProperties']> = {},
    extra: Partial<ScopeRegistrationEvent> = {},
  ): ScopeRegistrationEvent => ({
    RequestType: type,
    ResponseURL: 'https://cloudformation-custom-resource-response.example.com/respond?x=1',
    StackId: STACK,
    RequestId: 'req-1',
    LogicalResourceId: 'BillingScopes',
    ResourceProperties: { ServiceToken: 'arn:aws:lambda:eu-central-1:111122223333:function:x', ApiUrl: API, Backend: 'billing', Scopes: ['billing/read', 'billing/invoke'], ...overrides },
    ...extra,
  });

  const trace = () => calls.map((c) => `${c.method} ${decodeURIComponent(new URL(c.url).pathname)}`);

  beforeEach(() => {
    calls = [];
    logs = [];
    outSpy = jest.spyOn(process.stdout, 'write').mockImplementation((l: any) => {
      logs.push(String(l).trimEnd());
      return true;
    });
  });
  afterEach(() => outSpy.mockRestore());

  it('scopeUrl encodes the scope as one path segment under platform/scopes, with or without a trailing slash on the API URL', () => {
    expect(scopeUrl(API, 'billing/read').toString()).toBe(`${API}platform/scopes/billing%2Fread`);
    expect(scopeUrl(API.slice(0, -1), 'billing/read').toString()).toBe(`${API}platform/scopes/billing%2Fread`);
    expect(physicalId('billing')).toBe('scope-registration:billing');
    expect(unclaimedId('billing')).toBe('scope-registration:billing:unclaimed');
    expect(ownerMarker({ StackId: STACK, LogicalResourceId: 'BillingScopes' })).toBe(MARKER);
    // An explicit Owner replaces the default marker; an absent or unusable one falls back to it.
    expect(ownerMarker({ StackId: STACK, LogicalResourceId: 'BillingScopes' }, { Owner: 'RuntimeIsolationInteg' })).toBe('RuntimeIsolationInteg');
    expect(ownerMarker({ StackId: STACK, LogicalResourceId: 'BillingScopes' }, { Owner: undefined })).toBe(MARKER);
    expect(ownerMarker({ StackId: STACK, LogicalResourceId: 'BillingScopes' }, { Owner: '' })).toBe(MARKER);
    expect(ownerMarker({ StackId: STACK, LogicalResourceId: 'BillingScopes' }, { Owner: 'x'.repeat(OWNER_MAX_LENGTH + 1) })).toBe(MARKER);
    expect(ownerProblem(undefined)).toBeUndefined();
    expect(ownerProblem('shared')).toBeUndefined();
    expect(ownerProblem('x'.repeat(OWNER_MAX_LENGTH))).toBeUndefined();
    expect(ownerProblem('')).toBe('Owner must be a non-empty string when given');
    expect(ownerProblem(42)).toBe('Owner must be a non-empty string when given');
    expect(ownerProblem('x'.repeat(OWNER_MAX_LENGTH + 1))).toBe('Owner must be at most 256 characters');
  });

  describe('an explicit Owner property (co-ownership, AgentBackend.scopeOwner)', () => {
    const OWNER = 'RuntimeIsolationInteg';

    it('Create puts every scope with the Owner as its description instead of the stack marker', async () => {
      const outcome = await handleEvent(event('Create', { Owner: OWNER }), deps());
      expect(outcome).toEqual({ status: 'SUCCESS', physicalResourceId: 'scope-registration:billing' });
      const puts = calls.filter((c) => c.method === 'PUT');
      expect(puts).toHaveLength(2);
      for (const c of puts) {
        expect(JSON.parse(c.body!)).toEqual({ description: OWNER });
      }
    });

    it("Create passes the owner check when the catalogue holds the same Owner (another stack's registration), so co-owning stacks deploy side by side", async () => {
      const outcome = await handleEvent(event('Create', { Owner: OWNER }), deps({ catalogue: { 'billing/read': OWNER, 'billing/invoke': OWNER } }));
      expect(outcome).toEqual({ status: 'SUCCESS', physicalResourceId: 'scope-registration:billing' });
      expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2);
      expect(logs).toEqual([]);
    });

    it("Create with an Owner is still refused when the catalogue holds a different marker (a stack's default one included), and a default-marker Create is refused by an Owner", async () => {
      expect(await handleEvent(event('Create', { Owner: OWNER }), deps({ catalogue: { 'billing/read': MARKER } }))).toEqual({
        status: 'FAILED',
        physicalResourceId: 'scope-registration:billing:unclaimed',
        reason: 'scope billing/read already registered by another stack; is another backend named billing deployed?',
      });
      expect(await handleEvent(event('Create', { Owner: 'other-owner' }), deps({ catalogue: { 'billing/read': OWNER } }))).toMatchObject({ status: 'FAILED', physicalResourceId: 'scope-registration:billing:unclaimed' });
      expect(await handleEvent(event('Create'), deps({ catalogue: { 'billing/read': OWNER } }))).toMatchObject({ status: 'FAILED', physicalResourceId: 'scope-registration:billing:unclaimed' });
      expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    });

    it('Update owner-checks an added scope against the Owner and puts the list under it', async () => {
      const previous = event('Update').ResourceProperties;
      const outcome = await handleEvent(
        event('Update', { Owner: OWNER, Scopes: ['billing/read', 'billing/invoke', 'billing/export'] }, { PhysicalResourceId: 'scope-registration:billing', OldResourceProperties: { ...previous, Owner: OWNER } }),
        deps({ catalogue: { 'billing/export': OWNER } }),
      );
      expect(outcome).toEqual({ status: 'SUCCESS', physicalResourceId: 'scope-registration:billing' });
      expect(trace()).toEqual([
        'GET /prod/platform/scopes/billing/export',
        'PUT /prod/platform/scopes/billing/read',
        'PUT /prod/platform/scopes/billing/invoke',
        'PUT /prod/platform/scopes/billing/export',
      ]);
      for (const c of calls.filter((x) => x.method === 'PUT')) {
        expect(JSON.parse(c.body!)).toEqual({ description: OWNER });
      }
    });

    it('Delete removes the scopes that carry the Owner (the first co-owner destroyed takes them for all), and skips ones under another marker', async () => {
      const outcome = await handleEvent(
        event('Delete', { Owner: OWNER }, { PhysicalResourceId: 'scope-registration:billing' }),
        deps({ catalogue: { 'billing/read': OWNER, 'billing/invoke': MARKER } }),
      );
      expect(outcome).toEqual({ status: 'SUCCESS', physicalResourceId: 'scope-registration:billing' });
      expect(trace()).toEqual(['GET /prod/platform/scopes/billing/read', 'DELETE /prod/platform/scopes/billing/read', 'GET /prod/platform/scopes/billing/invoke']);
      expect(logs.map((l) => JSON.parse(l))).toEqual([{ level: 'ERROR', message: 'scope owned by another stack; left in the catalogue', backend: 'billing', scope: 'billing/invoke' }]);
    });

    it('refuses an Owner that is not a non-empty string of at most 256 characters on Create and Update, like any other property; Delete succeeds without a call', async () => {
      expect(await handleEvent(event('Create', { Owner: '' }), deps())).toEqual({ status: 'FAILED', physicalResourceId: 'scope-registration:billing', reason: 'Owner must be a non-empty string when given' });
      expect(await handleEvent(event('Create', { Owner: 42 as any }), deps())).toMatchObject({ status: 'FAILED', reason: 'Owner must be a non-empty string when given' });
      expect(await handleEvent(event('Create', { Owner: ['a'] as any }), deps())).toMatchObject({ status: 'FAILED', reason: 'Owner must be a non-empty string when given' });
      expect(await handleEvent(event('Create', { Owner: 'x'.repeat(257) }), deps())).toMatchObject({ status: 'FAILED', reason: 'Owner must be at most 256 characters' });
      expect(await handleEvent(event('Update', { Owner: '' }, { PhysicalResourceId: 'scope-registration:billing' }), deps())).toMatchObject({ status: 'FAILED', reason: 'Owner must be a non-empty string when given' });
      expect(calls).toHaveLength(0);
      expect(await handleEvent(event('Delete', { Owner: '' }, { PhysicalResourceId: 'scope-registration:billing' }), deps())).toEqual({ status: 'SUCCESS', physicalResourceId: 'scope-registration:billing' });
      expect(calls).toHaveLength(0);
      // The longest accepted Owner is used as written.
      const longest = 'y'.repeat(256);
      expect(await handleEvent(event('Create', { Owner: longest }), deps())).toMatchObject({ status: 'SUCCESS' });
      expect(JSON.parse(calls.find((c) => c.method === 'PUT')!.body!)).toEqual({ description: longest });
    });
  });

  it('isApiGatewayHost accepts only <api>.execute-api.<region>.amazonaws.com in the given Region', () => {
    expect(isApiGatewayHost('abc123.execute-api.eu-central-1.amazonaws.com', 'eu-central-1')).toBe(true);
    expect(isApiGatewayHost('abc123.execute-api.us-east-1.amazonaws.com', 'eu-central-1')).toBe(false);
    expect(isApiGatewayHost('.execute-api.eu-central-1.amazonaws.com', 'eu-central-1')).toBe(false);
    expect(isApiGatewayHost('execute-api.eu-central-1.amazonaws.com.attacker.example.com', 'eu-central-1')).toBe(false);
    expect(isApiGatewayHost('abc123.execute-api.eu-central-1.amazonaws.com', '')).toBe(false);
  });

  it('Create looks each scope up, then puts every scope with the owner marker as its description, in order, and succeeds with the fixed physical id', async () => {
    const outcome = await handleEvent(event('Create'), deps());
    expect(outcome).toEqual({ status: 'SUCCESS', physicalResourceId: 'scope-registration:billing' });
    expect(trace()).toEqual([
      'GET /prod/platform/scopes/billing/read',
      'GET /prod/platform/scopes/billing/invoke',
      'PUT /prod/platform/scopes/billing/read',
      'PUT /prod/platform/scopes/billing/invoke',
    ]);
    for (const c of calls.filter((x) => x.method === 'PUT')) {
      expect(JSON.parse(c.body!)).toEqual({ description: MARKER });
    }
    expect(logs).toEqual([]);
  });

  it('a retried Create finds its own marker in the catalogue and goes on', async () => {
    const outcome = await handleEvent(event('Create'), deps({ catalogue: { 'billing/read': MARKER } }));
    expect(outcome).toEqual({ status: 'SUCCESS', physicalResourceId: 'scope-registration:billing' });
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2);
  });

  it("Create fails with the ':unclaimed' physical id when a scope is already registered under another stack's marker, and puts nothing", async () => {
    const outcome = await handleEvent(event('Create'), deps({ catalogue: { 'billing/invoke': OTHER_MARKER } }));
    expect(outcome).toEqual({
      status: 'FAILED',
      physicalResourceId: 'scope-registration:billing:unclaimed',
      reason: 'scope billing/invoke already registered by another stack; is another backend named billing deployed?',
    });
    expect(trace()).toEqual(['GET /prod/platform/scopes/billing/read', 'GET /prod/platform/scopes/billing/invoke']);
    expect(logs.map((l) => JSON.parse(l))).toEqual([{ level: 'ERROR', message: 'scope already registered by another stack', backend: 'billing', scope: 'billing/invoke' }]);
    // A registered scope with no marker at all, or an unreadable body, is not ours either.
    calls = [];
    expect(await handleEvent(event('Create'), deps({ rawBody: 'not json' }))).toMatchObject({ status: 'FAILED', physicalResourceId: 'scope-registration:billing:unclaimed' });
    expect(await handleEvent(event('Create'), deps({ catalogue: { 'billing/read': undefined } }))).toMatchObject({ status: 'FAILED', physicalResourceId: 'scope-registration:billing:unclaimed' });
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it("Delete with a physical id ending ':unclaimed' (the rollback of a refused Create) succeeds without a call", async () => {
    const outcome = await handleEvent(event('Delete', {}, { PhysicalResourceId: 'scope-registration:billing:unclaimed' }), deps({ catalogue: { 'billing/read': OTHER_MARKER } }));
    expect(outcome).toEqual({ status: 'SUCCESS', physicalResourceId: 'scope-registration:billing:unclaimed' });
    expect(calls).toHaveLength(0);
  });

  it('Create fails when the lookup is refused or unreachable, with the ordinary physical id (its rollback Delete removes only our own scopes)', async () => {
    let outcome = await handleEvent(event('Create'), deps({ status: { GET: 403 } }));
    expect(outcome).toEqual({ status: 'FAILED', physicalResourceId: 'scope-registration:billing', reason: 'GET /platform/scopes/billing/read returned HTTP 403' });
    expect(calls).toHaveLength(1);
    calls = [];
    outcome = await handleEvent(event('Create'), deps({ failOn: /invoke/, failMethod: 'GET' }));
    expect(outcome).toEqual({ status: 'FAILED', physicalResourceId: 'scope-registration:billing', reason: 'GET /platform/scopes/billing/invoke failed: TypeError' });
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('Create fails the deployment when the API refuses a scope, naming the scope and the status, never the body; later scopes are not tried', async () => {
    const outcome = await handleEvent(event('Create'), deps({ status: { PUT: 400 } }));
    expect(outcome.status).toBe('FAILED');
    expect(outcome.physicalResourceId).toBe('scope-registration:billing');
    expect(outcome.reason).toBe('PUT /platform/scopes/billing/read returned HTTP 400');
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(logs.map((l) => JSON.parse(l))).toEqual([{ level: 'ERROR', message: 'scope registration refused', backend: 'billing', scope: 'billing/read', status: 400 }]);
  });

  it('Create fails when the API cannot be reached (a stale or absent tenant-identity), with the error name only', async () => {
    const outcome = await handleEvent(event('Create'), deps({ failOn: /read/, failMethod: 'PUT' }));
    expect(outcome).toMatchObject({ status: 'FAILED', reason: 'PUT /platform/scopes/billing/read failed: TypeError' });
    expect(logs.map((l) => JSON.parse(l))).toEqual([{ level: 'ERROR', message: 'scope registration failed', backend: 'billing', scope: 'billing/read', error: 'TypeError' }]);
  });

  it('Update owner-checks only the added scopes, puts the new list, then deletes the scopes the old list had and the new one lacks when they carry our marker', async () => {
    const outcome = await handleEvent(
      event('Update', { Scopes: ['billing/read', 'billing/export'] }, { PhysicalResourceId: 'scope-registration:billing', OldResourceProperties: { ApiUrl: API, Backend: 'billing', Scopes: ['billing/read', 'billing/invoke'] } }),
      deps({ catalogue: { 'billing/read': MARKER, 'billing/invoke': MARKER } }),
    );
    expect(outcome).toEqual({ status: 'SUCCESS', physicalResourceId: 'scope-registration:billing' });
    expect(trace()).toEqual([
      'GET /prod/platform/scopes/billing/export',
      'PUT /prod/platform/scopes/billing/read',
      'PUT /prod/platform/scopes/billing/export',
      'GET /prod/platform/scopes/billing/invoke',
      'DELETE /prod/platform/scopes/billing/invoke',
    ]);
  });

  it('Update fails with the old physical id when an added scope belongs to another stack', async () => {
    const outcome = await handleEvent(
      event('Update', { Scopes: ['billing/read', 'billing/export'] }, { PhysicalResourceId: 'scope-registration:billing', OldResourceProperties: { ApiUrl: API, Backend: 'billing', Scopes: ['billing/read'] } }),
      deps({ catalogue: { 'billing/export': OTHER_MARKER } }),
    );
    expect(outcome).toEqual({
      status: 'FAILED',
      physicalResourceId: 'scope-registration:billing',
      reason: 'scope billing/export already registered by another stack; is another backend named billing deployed?',
    });
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('Update with no old properties, or an unchanged list, deletes nothing', async () => {
    await handleEvent(event('Update', {}, { PhysicalResourceId: 'scope-registration:billing' }), deps());
    expect(calls.every((c) => c.method !== 'DELETE')).toBe(true);
    calls = [];
    await handleEvent(event('Update', {}, { PhysicalResourceId: 'scope-registration:billing', OldResourceProperties: { ApiUrl: API, Backend: 'billing', Scopes: ['billing/invoke', 'billing/read'] } }), deps());
    expect(calls.every((c) => c.method === 'PUT')).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('Update that changes Backend answers the NEW physical id and leaves the old backend\'s scopes to the Delete CloudFormation sends for the old id', async () => {
    const outcome = await handleEvent(
      event('Update', { Backend: 'invoicing', Scopes: ['invoicing/read'] }, { PhysicalResourceId: 'scope-registration:billing', OldResourceProperties: { ApiUrl: API, Backend: 'billing', Scopes: ['billing/read', 'billing/invoke'] } }),
      deps(),
    );
    expect(outcome).toEqual({ status: 'SUCCESS', physicalResourceId: 'scope-registration:invoicing' });
    expect(trace()).toEqual(['GET /prod/platform/scopes/invoicing/read', 'PUT /prod/platform/scopes/invoicing/read']);
    // The Delete of the old resource then removes the old backend's scopes (its own marker).
    calls = [];
    await handleEvent(event('Delete', {}, { PhysicalResourceId: 'scope-registration:billing' }), deps({ catalogue: { 'billing/read': MARKER, 'billing/invoke': MARKER } }));
    expect(trace()).toEqual([
      'GET /prod/platform/scopes/billing/read',
      'DELETE /prod/platform/scopes/billing/read',
      'GET /prod/platform/scopes/billing/invoke',
      'DELETE /prod/platform/scopes/billing/invoke',
    ]);
    // A failed Update keeps the old id.
    calls = [];
    expect(
      await handleEvent(
        event('Update', { Backend: 'invoicing', Scopes: ['invoicing/read'] }, { PhysicalResourceId: 'scope-registration:billing', OldResourceProperties: { ApiUrl: API, Backend: 'billing', Scopes: ['billing/read'] } }),
        deps({ status: { PUT: 500 } }),
      ),
    ).toEqual({ status: 'FAILED', physicalResourceId: 'scope-registration:billing', reason: 'PUT /platform/scopes/invoicing/read returned HTTP 500' });
  });

  it('Delete removes every scope that carries our marker (or the pre-marker description) and succeeds; an absent scope is skipped', async () => {
    const outcome = await handleEvent(
      event('Delete', { Scopes: ['billing/read', 'billing/invoke', 'billing/export'] }, { PhysicalResourceId: 'scope-registration:billing' }),
      deps({ catalogue: { 'billing/read': MARKER, 'billing/invoke': 'agentic-runtime-isolation backend billing (ADR-0025)' }, status: { DELETE: 404 } }),
    );
    expect(outcome).toEqual({ status: 'SUCCESS', physicalResourceId: 'scope-registration:billing' });
    expect(trace()).toEqual([
      'GET /prod/platform/scopes/billing/read',
      'DELETE /prod/platform/scopes/billing/read',
      'GET /prod/platform/scopes/billing/invoke',
      'DELETE /prod/platform/scopes/billing/invoke',
      'GET /prod/platform/scopes/billing/export',
    ]);
    expect(logs).toEqual([]);
  });

  it('Delete skips a scope whose description names another owner, or whose owner cannot be read, and leaves it in the catalogue', async () => {
    let outcome = await handleEvent(event('Delete', {}, { PhysicalResourceId: 'scope-registration:billing' }), deps({ catalogue: { 'billing/read': OTHER_MARKER, 'billing/invoke': undefined } }));
    expect(outcome.status).toBe('SUCCESS');
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    expect(logs.map((l) => JSON.parse(l))).toEqual([
      { level: 'ERROR', message: 'scope owned by another stack; left in the catalogue', backend: 'billing', scope: 'billing/read' },
      { level: 'ERROR', message: 'scope owned by another stack; left in the catalogue', backend: 'billing', scope: 'billing/invoke' },
    ]);
    calls = [];
    logs = [];
    outcome = await handleEvent(event('Delete', {}, { PhysicalResourceId: 'scope-registration:billing' }), deps({ status: { GET: 503 } }));
    expect(outcome.status).toBe('SUCCESS');
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    expect(logs.map((l) => JSON.parse(l).message)).toEqual(['scope lookup refused', 'scope lookup refused']);
  });

  it('Delete is best effort: a refused or unreachable DELETE is logged, the rest are still tried, and the stack delete proceeds', async () => {
    const owned = { 'billing/read': MARKER, 'billing/invoke': MARKER };
    let outcome = await handleEvent(event('Delete', {}, { PhysicalResourceId: 'scope-registration:billing' }), deps({ catalogue: owned, status: { DELETE: 403 } }));
    expect(outcome.status).toBe('SUCCESS');
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(2);
    expect(logs.map((l) => JSON.parse(l).message)).toEqual(['scope removal refused; scope left in the catalogue', 'scope removal refused; scope left in the catalogue']);
    calls = [];
    logs = [];
    outcome = await handleEvent(event('Delete', {}, { PhysicalResourceId: 'scope-registration:billing' }), deps({ catalogue: owned, failOn: /./, failMethod: 'DELETE' }));
    expect(outcome.status).toBe('SUCCESS');
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(2);
    expect(logs.map((l) => JSON.parse(l))).toEqual([
      { level: 'ERROR', message: 'scope removal failed; scope left in the catalogue', backend: 'billing', scope: 'billing/read', error: 'TypeError' },
      { level: 'ERROR', message: 'scope removal failed; scope left in the catalogue', backend: 'billing', scope: 'billing/invoke', error: 'TypeError' },
    ]);
    // A lookup that cannot be reached at all (tenant-identity torn down first) is logged per scope, and the delete still succeeds.
    calls = [];
    logs = [];
    outcome = await handleEvent(event('Delete', {}, { PhysicalResourceId: 'scope-registration:billing' }), deps({ failOn: /./ }));
    expect(outcome.status).toBe('SUCCESS');
    expect(logs.map((l) => JSON.parse(l))).toEqual([
      { level: 'ERROR', message: 'scope lookup failed', backend: 'billing', scope: 'billing/read', error: 'TypeError' },
      { level: 'ERROR', message: 'scope lookup failed', backend: 'billing', scope: 'billing/invoke', error: 'TypeError' },
    ]);
  });

  it('refuses malformed properties on Create and Update, naming the property; Delete with malformed properties succeeds without a call', async () => {
    expect(await handleEvent(event('Create', { ApiUrl: 'http://plain.example.com/' }), deps())).toMatchObject({ status: 'FAILED', reason: 'ApiUrl must be an https URL' });
    expect(await handleEvent(event('Create', { ApiUrl: 'https://' }), deps())).toMatchObject({ status: 'FAILED', reason: 'ApiUrl must be an https URL' });
    expect(await handleEvent(event('Create', { Backend: '' }), deps())).toMatchObject({ status: 'FAILED', reason: 'Backend must be the backend name' });
    expect(await handleEvent(event('Create', { Scopes: [] }), deps())).toMatchObject({ status: 'FAILED', reason: 'Scopes must name at least one scope (ADR-0025)' });
    expect(await handleEvent(event('Create', { Scopes: ['billing/Read'] }), deps())).toMatchObject({ status: 'FAILED', reason: expect.stringMatching(/^Scopes 'billing\/Read' must match/) });
    expect(await handleEvent(event('Create', { Scopes: ['billing/read', 'billing/read'] }), deps())).toMatchObject({ status: 'FAILED', reason: 'Scopes must not repeat a scope' });
    expect(await handleEvent(event('Update', { Scopes: 'billing/read' as any }), deps())).toMatchObject({ status: 'FAILED', reason: 'Scopes must be a list of scope names' });
    expect(calls).toHaveLength(0);
    expect(await handleEvent(event('Delete', { Scopes: [] }, { PhysicalResourceId: 'scope-registration:billing' }), deps())).toEqual({ status: 'SUCCESS', physicalResourceId: 'scope-registration:billing' });
    expect(calls).toHaveLength(0);
  });

  it('refuses an ApiUrl that is not an API Gateway endpoint in the function\'s Region, so the signature is never sent elsewhere; Delete still succeeds', async () => {
    const reason = 'ApiUrl must be an API Gateway URL in eu-central-1 (<api>.execute-api.eu-central-1.amazonaws.com)';
    expect(await handleEvent(event('Create', { ApiUrl: 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/' }), deps())).toMatchObject({ status: 'FAILED', reason });
    expect(await handleEvent(event('Create', { ApiUrl: 'https://api.attacker.example.com/prod/' }), deps())).toMatchObject({ status: 'FAILED', reason });
    expect(await handleEvent(event('Create', { ApiUrl: 'https://abc123.execute-api.eu-central-1.amazonaws.com.attacker.example.com/' }), deps())).toMatchObject({ status: 'FAILED', reason });
    expect(await handleEvent(event('Update', { ApiUrl: 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/' }, { PhysicalResourceId: 'scope-registration:billing' }), deps())).toMatchObject({ status: 'FAILED', reason });
    expect(await handleEvent(event('Create'), { ...deps(), region: '' })).toMatchObject({ status: 'FAILED', reason: 'ApiUrl must be an API Gateway URL in this Region (<api>.execute-api.<region>.amazonaws.com)' });
    expect(calls).toHaveLength(0);
    expect(await handleEvent(event('Delete', { ApiUrl: 'https://api.attacker.example.com/prod/' }, { PhysicalResourceId: 'scope-registration:billing' }), deps())).toEqual({ status: 'SUCCESS', physicalResourceId: 'scope-registration:billing' });
    expect(calls).toHaveLength(0);
  });

  it('refuses a Scopes list that names another owner on Create and Update, so a direct invoke cannot register a foreign name; nothing is called', async () => {
    const foreign = ['billing/read', 'default/chat'];
    const reason = "Scopes 'default/chat' must be owned by this backend: billing/<action> (ADR-0025)";
    expect(await handleEvent(event('Create', { Scopes: foreign }), deps())).toEqual({ status: 'FAILED', physicalResourceId: 'scope-registration:billing', reason });
    expect(await handleEvent(event('Update', { Scopes: foreign }, { PhysicalResourceId: 'scope-registration:billing', OldResourceProperties: event('Update').ResourceProperties }), deps())).toEqual({
      status: 'FAILED',
      physicalResourceId: 'scope-registration:billing',
      reason,
    });
    expect(await handleEvent(event('Create', { Scopes: ['tenant-admin/users'] }), deps())).toMatchObject({ status: 'FAILED', reason: expect.stringMatching(/must be owned by this backend: billing/) });
    expect(calls).toHaveLength(0);
    // An old list that carried a foreign name (it cannot, through the construct) is not deleted on the owner's behalf either.
    const previous = { ...event('Update').ResourceProperties, Scopes: ['billing/read', 'default/chat'] };
    expect(
      await handleEvent(event('Update', { Scopes: ['billing/invoke'] }, { PhysicalResourceId: 'scope-registration:billing', OldResourceProperties: previous }), deps({ catalogue: { 'billing/read': MARKER } })),
    ).toMatchObject({ status: 'SUCCESS' });
    expect(trace()).toEqual([
      'GET /prod/platform/scopes/billing/invoke',
      'PUT /prod/platform/scopes/billing/invoke',
      'GET /prod/platform/scopes/billing/read',
      'DELETE /prod/platform/scopes/billing/read',
    ]);
  });

  describe('signedPlatformCall', () => {
    // The documented example key pair from the AWS SigV4 reference; never a real credential.
    const CREDS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };

    it('signs with SigV4 for execute-api, sends the signed headers with a per-attempt timeout signal, and reads the body for a GET only', async () => {
      const seen: { url: string; init: RequestInit }[] = [];
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(url), init: init! });
        return new Response('{"scope":{"name":"billing/read"}}', { status: 200 });
      }) as typeof fetch;
      const call = signedPlatformCall('eu-central-1', fetchImpl, CREDS, 0);
      const put = await call('PUT', scopeUrl(API, 'billing/read'), '{"description":"d"}');
      expect(put).toEqual({ status: 200 });
      expect(seen).toHaveLength(1);
      const headers = seen[0].init.headers as Record<string, string>;
      expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/eu-central-1\/execute-api\/aws4_request, SignedHeaders=/);
      expect(headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
      expect(headers['content-type']).toBe('application/json');
      expect(seen[0].init.method).toBe('PUT');
      expect(seen[0].init.body).toBe('{"description":"d"}');
      expect(seen[0].init.signal).toBeInstanceOf(AbortSignal);
      expect(seen[0].init.signal!.aborted).toBe(false);
      expect(CALL_TIMEOUT_MS).toBe(10_000);
      // A DELETE carries no body and no content-type; its signal is a fresh one.
      await call('DELETE', scopeUrl(API, 'billing/read'));
      expect((seen[1].init.headers as Record<string, string>)['content-type']).toBeUndefined();
      expect(seen[1].init.body).toBeUndefined();
      expect(seen[1].init.signal).toBeInstanceOf(AbortSignal);
      expect(seen[1].init.signal).not.toBe(seen[0].init.signal);
      // A GET answers the body too (the owner check parses it).
      const get = await call('GET', scopeUrl(API, 'billing/read'));
      expect(get).toEqual({ status: 200, body: '{"scope":{"name":"billing/read"}}' });
    });

    it('retries once after the backoff on 429, 5xx or a transport error, then returns what it got', async () => {
      let answers: (number | Error)[] = [];
      let attempts = 0;
      const fetchImpl = (async () => {
        const next = answers[attempts++];
        if (next instanceof Error) throw next;
        return new Response(next === 204 ? null : '', { status: next });
      }) as typeof fetch;
      const call = signedPlatformCall('eu-central-1', fetchImpl, CREDS, 1);
      // 429 then 200: two attempts, the second answer.
      answers = [429, 200];
      attempts = 0;
      expect(await call('PUT', scopeUrl(API, 'billing/read'), '{}')).toEqual({ status: 200 });
      expect(attempts).toBe(2);
      // 503 then 502: two attempts, the retry's answer; no third.
      answers = [503, 502];
      attempts = 0;
      expect(await call('PUT', scopeUrl(API, 'billing/read'), '{}')).toEqual({ status: 502 });
      expect(attempts).toBe(2);
      // A timeout (transport error) then 204.
      answers = [Object.assign(new Error('aborted'), { name: 'TimeoutError' }), 204];
      attempts = 0;
      expect(await call('DELETE', scopeUrl(API, 'billing/read'))).toEqual({ status: 204 });
      expect(attempts).toBe(2);
      expect(logs.map((l) => JSON.parse(l))).toEqual([{ level: 'ERROR', message: 'platform call failed; retrying once', method: 'DELETE', error: 'TimeoutError' }]);
      // Two transport errors: the second is thrown.
      answers = [new TypeError('fetch failed'), new TypeError('fetch failed')];
      attempts = 0;
      await expect(call('GET', scopeUrl(API, 'billing/read'))).rejects.toThrow(TypeError);
      expect(attempts).toBe(2);
      // A 500 then a transport error: the 500 is returned (the more telling answer).
      answers = [500, new TypeError('fetch failed')];
      attempts = 0;
      logs = [];
      expect(await call('PUT', scopeUrl(API, 'billing/read'), '{}')).toEqual({ status: 500 });
      expect(logs.map((l) => JSON.parse(l).message)).toEqual(['platform call retry failed']);
      // A 4xx other than 429 is not retried.
      answers = [400, 200];
      attempts = 0;
      expect(await call('PUT', scopeUrl(API, 'billing/read'), '{}')).toEqual({ status: 400 });
      expect(attempts).toBe(1);
    });
  });

  describe('handler (createHandler)', () => {
    const answers = () => {
      const out: { event: ScopeRegistrationEvent; outcome: ScopeRegistrationOutcome }[] = [];
      return { out, respond: async (ev: ScopeRegistrationEvent, outcome: ScopeRegistrationOutcome) => void out.push({ event: ev, outcome }) };
    };
    const context = (remaining: number) => ({ getRemainingTimeInMillis: () => remaining });

    it('runs the event and answers CloudFormation once with the outcome', async () => {
      const a = answers();
      const h = createHandler({ call: deps().call, region: REGION, respond: a.respond });
      await h(event('Create'), context(60_000));
      expect(a.out).toHaveLength(1);
      expect(a.out[0].outcome).toEqual({ status: 'SUCCESS', physicalResourceId: 'scope-registration:billing' });
      expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2);
    });

    it('answers FAILED with the error name when the event throws, and never throws itself', async () => {
      const a = answers();
      const h = createHandler({
        call: async () => {
          throw new RangeError('boom');
        },
        region: REGION,
        respond: a.respond,
      });
      // An event without properties makes handleEvent throw (a TypeError on the property read): answered FAILED, with the fallback id.
      await h({ ...event('Create'), ResourceProperties: undefined as unknown as ScopeRegistrationEvent['ResourceProperties'] }, context(60_000));
      expect(a.out).toHaveLength(1);
      expect(a.out[0].outcome).toEqual({ status: 'FAILED', physicalResourceId: 'scope-registration:unknown', reason: 'TypeError' });
      expect(logs.map((l) => JSON.parse(l))).toEqual([{ level: 'ERROR', message: 'scope registration handler failed', error: 'TypeError' }]);
      // A call that throws something handleEvent does not classify is still answered (here: the GET path turns it into a FAILED reason).
      await h(event('Create'), context(60_000));
      expect(a.out[1].outcome).toMatchObject({ status: 'FAILED', reason: 'GET /platform/scopes/billing/read failed: RangeError' });
    });

    it('races the event against the remaining time minus the margin and answers FAILED on timeout, with the event\'s physical id', async () => {
      const a = answers();
      const h = createHandler({
        call: () => new Promise(() => undefined), // never answers
        region: REGION,
        respond: a.respond,
      });
      const started = Date.now();
      await h(event('Update', {}, { PhysicalResourceId: 'scope-registration:billing' }), context(2_050));
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(a.out).toEqual([{ event: expect.anything(), outcome: { status: 'FAILED', physicalResourceId: 'scope-registration:billing', reason: 'HandlerTimeout' } }]);
      expect(logs.map((l) => JSON.parse(l))).toEqual([{ level: 'ERROR', message: 'scope registration handler failed', error: 'HandlerTimeout' }]);
      // Without a context the budget is zero: an event that needs a call times out at once; one that needs none still answers.
      const b = answers();
      const g = createHandler({ call: deps().call, region: REGION, respond: b.respond });
      await g(event('Delete', {}, { PhysicalResourceId: 'scope-registration:billing:unclaimed' }));
      expect(b.out[0].outcome).toEqual({ status: 'SUCCESS', physicalResourceId: 'scope-registration:billing:unclaimed' });
    });

    it('reads the Region from AWS_REGION and builds the signed call once, on first use', async () => {
      const saved = process.env.AWS_REGION;
      process.env.AWS_REGION = 'us-east-1';
      try {
        const a = answers();
        const h = createHandler({ call: deps().call, respond: a.respond });
        await h(event('Create'), context(60_000));
        expect(a.out[0].outcome).toEqual({ status: 'FAILED', physicalResourceId: 'scope-registration:billing', reason: 'ApiUrl must be an API Gateway URL in us-east-1 (<api>.execute-api.us-east-1.amazonaws.com)' });
      } finally {
        if (saved === undefined) delete process.env.AWS_REGION;
        else process.env.AWS_REGION = saved;
      }
    });
  });

  it('respond PUTs the outcome to the ResponseURL and resolves even when the request errors', async () => {
    const written: string[] = [];
    const request = ((options: any, callback: (res: any) => void) => {
      expect(options.method).toBe('PUT');
      expect(options.hostname).toBe('cloudformation-custom-resource-response.example.com');
      return {
        on: () => undefined,
        end: (body: string) => {
          written.push(body);
          callback({ resume: () => undefined, on: (_e: string, cb: () => void) => cb() });
        },
      };
    }) as unknown as typeof import('node:https').request;
    await respond(event('Create'), { status: 'SUCCESS', physicalResourceId: 'scope-registration:billing' }, request);
    expect(JSON.parse(written[0])).toMatchObject({ Status: 'SUCCESS', PhysicalResourceId: 'scope-registration:billing', Reason: 'See ADR-0025', LogicalResourceId: 'BillingScopes' });
    const failing = ((_o: any, _cb: any) => ({ on: (e: string, cb: () => void) => e === 'error' && cb(), end: () => undefined })) as unknown as typeof import('node:https').request;
    await expect(respond(event('Create'), { status: 'FAILED', physicalResourceId: 'x', reason: 'r' }, failing)).resolves.toBeUndefined();
  });
});
