// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The `parse` step's consumer path (spec §8): one call through the producer's
 * sample agent with its deterministic `tool <target>/<tool> {json}` probe, as
 * a consumer's agent would make it, so the grant and the 120 s ingress path
 * are exercised, not only the tools gateway.
 *
 * It needs a real identity: a tenant and its admin user in tenant-identity's
 * `shared-pool` (created through its platform API with SigV4, deleted at the
 * end), a subscription for `run-code/*` in the ingress's entitlement store
 * (a vendor call, SigV4), and the user's identity token as the bearer. The
 * tool target is called with exactly the grant the entitlement store holds.
 */

import { PutObjectCommand } from '@aws-sdk/client-s3';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { TOOL_NAME, TOOL_TARGET } from './common';
import { type Ctx } from './ctx';
import { INVOICES } from './fixtures';
import { signRequest } from './sigv4';

const IDENTITY_PREFIX = '/application-plane/shared/identity';
const VENDOR_SCOPE = 'app/use';

async function param(c: Ctx, name: string): Promise<string> {
  const r = await c.aws.ssm.send(new GetParameterCommand({ Name: name }));
  return r.Parameter?.Value ?? '';
}

async function signed(c: Ctx, method: string, url: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const headers = signRequest({
    method,
    url,
    region: c.aws.region,
    service: 'execute-api',
    credentials: await c.aws.credentials(),
    body: payload,
    headers: payload ? { 'content-type': 'application/json' } : {},
  });
  const res = await fetch(url, { method, headers, body: payload || undefined });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // an empty or non-JSON answer is a status only
  }
  return { status: res.status, json };
}

/** One call through the sample agent as a real user of a throwaway tenant; records its checks on `c.rec`. */
export async function agentPath(c: Ctx): Promise<void> {
  const endpoint = c.out.EndpointUrl;
  const entitlements = c.out.EntitlementsApiUrl;
  if (!endpoint || !entitlements) {
    c.rec.check('the stack publishes the ingress endpoint and the entitlements API', false);
    return;
  }
  let api = await param(c, `${IDENTITY_PREFIX}/apiUrl`);
  if (!api.endsWith('/')) api += '/';
  const name = `rcinteg${c.runId}`.slice(0, 40);
  let tenantId: string | undefined;
  // The scope the throwaway tenant gets must be in tenant-identity's catalogue; a fresh pool has none. The run adds it when missing and leaves it:
  // the pool is a shared fixture, and another run (agentic-runtime-isolation's) may use the same scope at the same time.
  const scopeUrl = `${api}platform/scopes/${encodeURIComponent(VENDOR_SCOPE)}`;
  if ((await signed(c, 'GET', scopeUrl)).status === 404) {
    const put = await signed(c, 'PUT', scopeUrl, { description: `run_code integ ${c.runId}` });
    c.rec.check(`the vendor scope ${VENDOR_SCOPE} is registered in tenant-identity (HTTP ${put.status})`, put.status === 200);
  }
  try {
    const t = await signed(c, 'POST', `${api}platform/tenants`, { name, adminEmail: `success+${name}@simulator.amazonses.com`, scopes: [VENDOR_SCOPE] });
    tenantId = (t.json.tenant as { tenantId?: string } | undefined)?.tenantId;
    const admin = (t.json.admin as { user?: { username?: string } } | undefined)?.user?.username;
    c.rec.check(`a throwaway tenant and its admin are created in tenant-identity (HTTP ${t.status})`, t.status === 201 && tenantId !== undefined && admin !== undefined);
    if (!tenantId || !admin) return;
    const password = `Rc-Integ-${Date.now().toString(36)}-Aa1!`;
    const tok = await signed(c, 'POST', `${api}platform/tenants/${tenantId}/users/${admin}/token`, { password });
    const bearer = tok.json.accessToken;
    c.rec.check(`the admin gets an identity token (HTTP ${tok.status})`, tok.status === 200 && typeof bearer === 'string');
    if (typeof bearer !== 'string') return;
    const ent = entitlements.endsWith('/') ? entitlements : `${entitlements}/`;
    const sub = await signed(c, 'PUT', `${ent}tenants/${tenantId}`, { agents: ['default'], tools: [`${TOOL_TARGET['run-code']}/*`] });
    c.rec.check(`a subscription for the run-code tools is written (HTTP ${sub.status})`, sub.status === 200 || sub.status === 204);
    await c.aws.s3.send(new PutObjectCommand({ Bucket: c.output('run-code', 'Bucket'), Key: `inputs/${tenantId}/invoice.csv`, Body: INVOICES.A.body.replace(/^A,/gm, `${tenantId},`) }));
    const code = 'import csv\nrows=list(csv.DictReader(open("/work/input")))\nprint(len(rows))';
    const prompt = `tool ${TOOL_TARGET['run-code']}/${TOOL_NAME} ${JSON.stringify({ code, input: 'invoice.csv' })}`;
    const res = await fetch(`${endpoint.replace(/\/$/, '')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream', 'Authorization': `Bearer ${bearer}` },
      body: JSON.stringify({ conversationId: `rcinteg${c.runId}`, prompt }),
      signal: AbortSignal.timeout(150_000),
    });
    const text = await res.text();
    const events = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
    c.rec.check(`the agent answers (HTTP ${res.status})`, res.status === 200 && events.length > 0);
    let toolText: string | undefined;
    for (const e of events) {
      try {
        const j = JSON.parse(e) as { tool?: unknown; result?: { content?: Array<{ text?: string }> } };
        if (j.tool !== undefined) toolText = j.result?.content?.[0]?.text;
      } catch {
        // not a JSON event
      }
    }
    const result = toolText ? (JSON.parse(toolText) as { exitCode?: number; stdout?: string }) : undefined;
    c.rec.check(`the run_code result came back through the agent (exit ${String(result?.exitCode)})`, result?.exitCode === 0 && (result.stdout ?? '').trim() === String(INVOICES.A.rows));
  } finally {
    if (tenantId) await signed(c, 'DELETE', `${api}platform/tenants/${tenantId}`);
  }
}
