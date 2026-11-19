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
import { withSignal } from './http';
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
  refused: 'That tenant is not available. Pick another.',
} as const;

/** The only place a token lives (ADR-0007). */
let session: Session | undefined;
let retry: (() => void) | undefined;
/** Aborted when the tenant's state is cleared, so its calls stop and their late answers are dropped (§7.2). */
let scope = new AbortController();
/** The agent run that is streaming; a new run or the end of the session aborts it. */
let agentRun: AbortController | undefined;

function status(text: string): void {
  ui.status.textContent = text;
}

/** In `single` mode tenants share one origin, so switching or signing out clears the tenant's state (§7.2). */
function clearTenantView(): void {
  scope.abort();
  scope = new AbortController();
  agentRun?.abort();
  agentRun = undefined;
  session = undefined;
  ui.actions.hidden = true;
  ui.whoamiOut.textContent = '';
  ui.agentOut.textContent = '';
  setBusy(false);
}

/** Disables the picker and Retry while an exchange runs, so two clicks cannot race (the last answer would win). */
function setBusy(busy: boolean): void {
  ui.retry.disabled = busy;
  for (const b of ui.picker.querySelectorAll('button')) b.disabled = busy;
}

function leave(): void {
  clearTenantView();
  signOut(env);
}

/** Narrows to `tenantId` in the current scope; an answer that arrives after the scope ended is dropped. */
function settle(subject: TokenSet, tenantId: string, config: ConfigJson): void {
  const { signal } = scope;
  setBusy(true);
  void settleTenant({ ...env, fetch: withSignal(env.fetch, signal) }, config, subject, tenantId).then((o) => {
    if (signal.aborted) return;
    setBusy(false);
    show(o, config);
  });
}

function showPicker(subject: TokenSet, tenants: readonly string[], config: ConfigJson, refused = false): void {
  ui.picker.replaceChildren();
  for (const t of tenants) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t;
    b.addEventListener('click', () => settle(subject, t, config));
    ui.picker.append(b);
  }
  ui.picker.hidden = false;
  status(refused ? MESSAGES.refused : 'Pick a tenant.');
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
      showPicker(outcome.subject, outcome.tenants, config, outcome.refused === true);
      return;
    case 'unavailable': {
      const { subject, tenantId } = outcome;
      retry = () => settle(subject, tenantId, config);
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
  ui.retry.addEventListener('click', () => retry?.());
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
    const { signal } = scope;
    ui.whoamiOut.textContent = '';
    whoami(withSignal(env.fetch, signal), s.accessToken).then(
      (body) => { if (!signal.aborted) ui.whoamiOut.textContent = JSON.stringify(body, null, 2); },
      () => { if (!signal.aborted) ui.whoamiOut.textContent = 'The call failed.'; },
    );
  });
  ui.agentForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const s = session;
    if (s === undefined) return;
    agentRun?.abort();
    const run = new AbortController();
    agentRun = run;
    void import('./agent-view').then((m) => m.runAgent(env.fetch, run.signal, s.accessToken, ui.backend.value, ui.prompt.value, ui.agentOut));
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
