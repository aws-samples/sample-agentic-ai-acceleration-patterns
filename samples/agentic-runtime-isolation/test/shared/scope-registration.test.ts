// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { catalogueUrl, handleEvent, physicalId, respond, type ScopeRegistrationEvent, scopeUrl, signedPlatformCall } from '../../src/shared/scope-registration.function';

/** The scope-registration custom resource handler (ADR-0025): PUT on Create/Update, DELETE on Delete, SigV4 to tenant-identity's platform API. */
describe('scope-registration custom resource handler', () => {
  const API = 'https://abc123.execute-api.eu-central-1.amazonaws.com/prod/';
  let calls: { method: string; url: string; body?: string }[];
  let logs: string[];
  let outSpy: jest.SpyInstance;
  /** A platform stub answering a fixed status per method, or throwing for a URL that matches `failOn`. */
  const deps = (status: Partial<Record<'PUT' | 'DELETE', number>> = {}, failOn?: RegExp) => ({
    call: async (method: 'PUT' | 'DELETE', url: URL, body?: string) => {
      calls.push({ method, url: url.toString(), body });
      if (failOn !== undefined && failOn.test(url.toString())) {
        throw new TypeError('fetch failed');
      }
      return status[method] ?? (method === 'PUT' ? 200 : 204);
    },
  });

  const event = (
    type: ScopeRegistrationEvent['RequestType'],
    overrides: Partial<ScopeRegistrationEvent['ResourceProperties']> = {},
    extra: Partial<ScopeRegistrationEvent> = {},
  ): ScopeRegistrationEvent => ({
    RequestType: type,
    ResponseURL: 'https://cloudformation-custom-resource-response.example.com/respond?x=1',
    StackId: 'arn:aws:cloudformation:eu-central-1:111122223333:stack/Backend/1',
    RequestId: 'req-1',
    LogicalResourceId: 'BillingScopes',
    ResourceProperties: { ServiceToken: 'arn:aws:lambda:eu-central-1:111122223333:function:x', ApiUrl: API, Backend: 'billing', Scopes: ['billing/read', 'billing/invoke'], ...overrides },
    ...extra,
  });

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
    expect(catalogueUrl(API).toString()).toBe(`${API}platform/scopes`);
    expect(physicalId('billing')).toBe('scope-registration:billing');
  });

  it('Create puts every scope with a description naming the backend, in order, and succeeds with the fixed physical id', async () => {
    const outcome = await handleEvent(event('Create'), deps());
    expect(outcome).toEqual({ status: 'SUCCESS', physicalResourceId: 'scope-registration:billing' });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['PUT', `${API}platform/scopes/billing%2Fread`],
      ['PUT', `${API}platform/scopes/billing%2Finvoke`],
    ]);
    for (const c of calls) {
      expect(JSON.parse(c.body!)).toEqual({ description: 'agentic-runtime-isolation backend billing (ADR-0025)' });
    }
    expect(logs).toEqual([]);
  });

  it('Create fails the deployment when the API refuses a scope, naming the scope and the status, never the body; later scopes are not tried', async () => {
    const outcome = await handleEvent(event('Create'), deps({ PUT: 400 }));
    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toBe('PUT /platform/scopes/billing/read returned HTTP 400');
    expect(calls).toHaveLength(1);
    expect(logs.map((l) => JSON.parse(l))).toEqual([{ level: 'ERROR', message: 'scope registration refused', backend: 'billing', scope: 'billing/read', status: 400 }]);
  });

  it('Create fails when the API cannot be reached (a stale or absent tenant-identity), with the error name only', async () => {
    const outcome = await handleEvent(event('Create'), deps({}, /read/));
    expect(outcome).toMatchObject({ status: 'FAILED', reason: 'PUT /platform/scopes/billing/read failed: TypeError' });
    expect(logs.map((l) => JSON.parse(l))).toEqual([{ level: 'ERROR', message: 'scope registration failed', backend: 'billing', scope: 'billing/read', error: 'TypeError' }]);
  });

  it('Update puts the new list, then deletes the scopes the old list had and the new one lacks', async () => {
    const outcome = await handleEvent(
      event('Update', { Scopes: ['billing/read', 'billing/export'] }, { PhysicalResourceId: 'scope-registration:billing', OldResourceProperties: { ApiUrl: API, Backend: 'billing', Scopes: ['billing/read', 'billing/invoke'] } }),
      deps(),
    );
    expect(outcome).toEqual({ status: 'SUCCESS', physicalResourceId: 'scope-registration:billing' });
    expect(calls.map((c) => [c.method, decodeURIComponent(new URL(c.url).pathname)])).toEqual([
      ['PUT', '/prod/platform/scopes/billing/read'],
      ['PUT', '/prod/platform/scopes/billing/export'],
      ['DELETE', '/prod/platform/scopes/billing/invoke'],
    ]);
  });

  it('Update with no old properties, or an unchanged list, deletes nothing', async () => {
    await handleEvent(event('Update', {}, { PhysicalResourceId: 'scope-registration:billing' }), deps());
    expect(calls.every((c) => c.method === 'PUT')).toBe(true);
    calls = [];
    await handleEvent(event('Update', {}, { PhysicalResourceId: 'scope-registration:billing', OldResourceProperties: { ApiUrl: API, Backend: 'billing', Scopes: ['billing/invoke', 'billing/read'] } }), deps());
    expect(calls.every((c) => c.method === 'PUT')).toBe(true);
  });

  it('Delete removes every scope and succeeds; a 404 is a removed scope', async () => {
    const outcome = await handleEvent(event('Delete', {}, { PhysicalResourceId: 'scope-registration:billing' }), deps({ DELETE: 404 }));
    expect(outcome).toEqual({ status: 'SUCCESS', physicalResourceId: 'scope-registration:billing' });
    expect(calls.map((c) => [c.method, decodeURIComponent(new URL(c.url).pathname)])).toEqual([
      ['DELETE', '/prod/platform/scopes/billing/read'],
      ['DELETE', '/prod/platform/scopes/billing/invoke'],
    ]);
    expect(logs).toEqual([]);
  });

  it('Delete is best effort: a refused or unreachable DELETE is logged, the rest are still tried, and the stack delete proceeds', async () => {
    let outcome = await handleEvent(event('Delete', {}, { PhysicalResourceId: 'scope-registration:billing' }), deps({ DELETE: 403 }));
    expect(outcome.status).toBe('SUCCESS');
    expect(calls).toHaveLength(2);
    expect(logs.map((l) => JSON.parse(l).message)).toEqual(['scope removal refused; scope left in the catalogue', 'scope removal refused; scope left in the catalogue']);
    calls = [];
    logs = [];
    outcome = await handleEvent(event('Delete', {}, { PhysicalResourceId: 'scope-registration:billing' }), deps({}, /./));
    expect(outcome.status).toBe('SUCCESS');
    expect(calls).toHaveLength(2);
    expect(logs.map((l) => JSON.parse(l))).toEqual([
      { level: 'ERROR', message: 'scope removal failed; scope left in the catalogue', backend: 'billing', scope: 'billing/read', error: 'TypeError' },
      { level: 'ERROR', message: 'scope removal failed; scope left in the catalogue', backend: 'billing', scope: 'billing/invoke', error: 'TypeError' },
    ]);
  });

  it('refuses malformed properties on Create and Update, naming the property; Delete with malformed properties succeeds without a call', async () => {
    expect(await handleEvent(event('Create', { ApiUrl: 'http://plain.example.com/' }), deps())).toMatchObject({ status: 'FAILED', reason: 'ApiUrl must be an https URL' });
    expect(await handleEvent(event('Create', { Backend: '' }), deps())).toMatchObject({ status: 'FAILED', reason: 'Backend must be the backend name' });
    expect(await handleEvent(event('Create', { Scopes: [] }), deps())).toMatchObject({ status: 'FAILED', reason: 'Scopes must name at least one scope (ADR-0025)' });
    expect(await handleEvent(event('Create', { Scopes: ['billing/Read'] }), deps())).toMatchObject({ status: 'FAILED', reason: expect.stringMatching(/^Scopes 'billing\/Read' must match/) });
    expect(await handleEvent(event('Create', { Scopes: ['billing/read', 'billing/read'] }), deps())).toMatchObject({ status: 'FAILED', reason: 'Scopes must not repeat a scope' });
    expect(await handleEvent(event('Update', { Scopes: 'billing/read' as any }), deps())).toMatchObject({ status: 'FAILED', reason: 'Scopes must be a list of scope names' });
    expect(calls).toHaveLength(0);
    expect(await handleEvent(event('Delete', { Scopes: [] }, { PhysicalResourceId: 'scope-registration:billing' }), deps())).toEqual({ status: 'SUCCESS', physicalResourceId: 'scope-registration:billing' });
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
    expect(await handleEvent(event('Update', { Scopes: ['billing/invoke'] }, { PhysicalResourceId: 'scope-registration:billing', OldResourceProperties: previous }), deps())).toMatchObject({ status: 'SUCCESS' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`PUT ${API}platform/scopes/billing%2Finvoke`, `DELETE ${API}platform/scopes/billing%2Fread`]);
  });

  it('signedPlatformCall signs with SigV4 for execute-api and sends the signed headers; only the status comes back', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init! });
      return new Response('{"scope":{"name":"billing/read"}}', { status: 200 });
    }) as typeof fetch;
    // The documented example key pair from the AWS SigV4 reference; never a real credential.
    const call = signedPlatformCall('eu-central-1', fetchImpl, { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' });
    const status = await call('PUT', scopeUrl(API, 'billing/read'), '{"description":"d"}');
    expect(status).toBe(200);
    expect(seen).toHaveLength(1);
    const headers = seen[0].init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/eu-central-1\/execute-api\/aws4_request, SignedHeaders=/);
    expect(headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
    expect(headers['content-type']).toBe('application/json');
    expect(seen[0].init.method).toBe('PUT');
    expect(seen[0].init.body).toBe('{"description":"d"}');
    // A DELETE carries no body and no content-type.
    await call('DELETE', scopeUrl(API, 'billing/read'));
    expect((seen[1].init.headers as Record<string, string>)['content-type']).toBeUndefined();
    expect(seen[1].init.body).toBeUndefined();
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
