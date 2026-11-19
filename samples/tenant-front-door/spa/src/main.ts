// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The demo SPA's DOM glue. The logic is in the other modules; this file
 * wires buttons to it. Every DOM write is `textContent`, `append` of a
 * string, or `createElement`, so the page runs under Trusted Types with no
 * policy (spec §7.2, ADR-0008).
 */

import { whoami } from './api';
import { beginSignIn, completeSignIn, Env, loadConfig, Outcome, Session, settleTenant, signOut } from './flow';
import type { FetchLike } from './http';
import { clearPending, parseCallback } from './signin';
import type { TokenSet } from './token';
import type { ConfigJson } from '../../src/shared/contracts';

declare global {
  interface Window {
    /** `location.search` as the inline callback script found it, before it dropped the code from the address (§7.1). */
    __tfdCallbackQuery?: string;
  }
}

const fetchFn: FetchLike = (url, init) => fetch(url, init);

const env: Env = {
  fetch: fetchFn,
  storage: window.sessionStorage,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  navigate: (url) => window.location.assign(url),
  here: { host: window.location.host, origin: window.location.origin },
};

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (e === null) throw new Error(`index.html has no #${id}`);
  return e as T;
}

const ui = {
  tenant: el('tenant'),
  status: el('status'),
  signin: el<HTMLButtonElement>('signin'),
  retry: el<HTMLButtonElement>('retry'),
  picker: el('picker'),
  actions: el('actions'),
  whoami: el<HTMLButtonElement>('whoami'),
  whoamiOut: el('whoami-out'),
  agentForm: el<HTMLFormElement>('agent-form'),
  backend: el<HTMLInputElement>('backend'),
  prompt: el<HTMLInputElement>('prompt'),
  agentOut: el('agent-out'),
  switchTenant: el<HTMLButtonElement>('switch-tenant'),
  signout: el<HTMLButtonElement>('signout'),
};

const MESSAGES = {
  config: 'The settings could not be loaded. Try again later.',
  failed: 'Sign-in did not complete. Sign in again.',
  unavailable: 'The sign-in service did not answer. Try again later.',
} as const;

/** The only place a token lives (ADR-0007). */
let session: Session | undefined;
let retry: (() => Promise<void>) | undefined;

function status(text: string): void {
  ui.status.textContent = text;
}

/** In `single` mode tenants share one origin, so switching or signing out clears the tenant's state (§7.2). */
function clearTenantView(): void {
  session = undefined;
  ui.actions.hidden = true;
  ui.whoamiOut.textContent = '';
  ui.agentOut.textContent = '';
}

function leave(): void {
  clearTenantView();
  signOut(env);
}

function showPicker(subject: TokenSet, tenants: readonly string[], config: ConfigJson): void {
  ui.picker.replaceChildren();
  for (const t of tenants) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t;
    b.addEventListener('click', () => void settleTenant(env, config, subject, t).then((o) => show(o, config)));
    ui.picker.append(b);
  }
  ui.picker.hidden = false;
  status('Pick a tenant.');
}

function show(outcome: Outcome, config: ConfigJson): void {
  ui.picker.hidden = true;
  ui.retry.hidden = true;
  ui.signin.hidden = true;
  switch (outcome.kind) {
    case 'signed-in':
      session = outcome.session;
      ui.actions.hidden = false;
      ui.switchTenant.hidden = (outcome.session.tenants?.length ?? 0) < 2 || config.tenantId !== undefined;
      status(`Signed in to tenant ${outcome.session.tenantId}.`);
      return;
    case 'pick-tenant':
      showPicker(outcome.subject, outcome.tenants, config);
      return;
    case 'unavailable': {
      const { subject, tenantId } = outcome;
      retry = async () => show(await settleTenant(env, config, subject, tenantId), config);
      ui.retry.hidden = false;
      status(MESSAGES.unavailable);
      return;
    }
    case 'failed':
      ui.signin.hidden = false;
      status(MESSAGES.failed);
      return;
    case 'sign-out':
      leave();
      return;
  }
}

async function start(): Promise<void> {
  const query = window.__tfdCallbackQuery ?? '';
  delete window.__tfdCallbackQuery;

  let config;
  try {
    config = await loadConfig(env);
  } catch {
    status(MESSAGES.config);
    return;
  }
  if (config.displayName !== undefined) ui.tenant.textContent = config.displayName;
  const cfg = config;

  ui.signin.addEventListener('click', () => void beginSignIn(env, cfg).catch(() => status(MESSAGES.failed)));
  ui.retry.addEventListener('click', () => void retry?.());
  ui.signout.addEventListener('click', leave);
  ui.switchTenant.addEventListener('click', () => {
    const s = session;
    if (s?.tenants === undefined) return;
    clearTenantView();
    showPicker(s.subject, s.tenants, cfg);
  });
  ui.whoami.addEventListener('click', () => {
    const s = session;
    if (s === undefined) return;
    ui.whoamiOut.textContent = '';
    whoami(env.fetch, s.accessToken).then(
      (body) => { ui.whoamiOut.textContent = JSON.stringify(body, null, 2); },
      () => { ui.whoamiOut.textContent = 'The call failed.'; },
    );
  });
  ui.agentForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const s = session;
    if (s === undefined) return;
    void import('./agent-view').then((m) => m.runAgent(env.fetch, s.accessToken, ui.backend.value, ui.prompt.value, ui.agentOut));
  });

  const cb = parseCallback(query);
  if (cb.kind === 'error') {
    clearPending(env.storage);
    show({ kind: 'failed' }, cfg);
    return;
  }
  if (cb.kind === 'code') {
    const outcome = await completeSignIn(env, cfg, cb.code, cb.state);
    window.history.replaceState(null, '', '/');
    show(outcome, cfg);
    return;
  }
  // No callback: start sign-in, which also ends the sign-out round trip (§3.5 step 5).
  status('Signing in…');
  await beginSignIn(env, cfg).catch(() => show({ kind: 'failed' }, cfg));
}

void start();
