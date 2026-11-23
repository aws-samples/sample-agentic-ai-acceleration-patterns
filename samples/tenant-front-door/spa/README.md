<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Demo SPA

A small single-page app in plain TypeScript that exercises the front door
from a browser: sign-in in both addressing modes, the token exchange for a
`tenants` token, `GET /api/whoami`, one streamed agent call, and sign-out.
It exists to show the browser half of the
[specification](../design/tenant-front-door.spec.md) (spec §3.5, §7), not
as an application.

## Build

From the sample directory:

```bash
npx projen spa:build
```

`npx projen build` runs it too. The build writes `build/spa/`:

| File | What |
|---|---|
| `index.html` | the inline callback script first, then the import map, the stylesheet and the entry, each script pinned by hash or `integrity` |
| `assets/<hash>.js`, `assets/<hash>.css` | content-hashed, so `/assets/*` can be cached as immutable |
| `csp.json` | `{"script-src": ["'sha384-…'", ...], "style-src": []}`: the hash sources the stack puts into the §7.1 policy; `style-src` stays empty because the policy is `style-src 'self'` |

The same sources build the same bytes. The build fails when a script
imports a chunk the import map does not pin, or when the HTML holds
something the policy refuses (an inline event handler, a `style` attribute
or `<style>`, a `javascript:` URL).

## Layout

| Module | Does |
|---|---|
| `src/config.ts` | parses `/config.json`, decides where sign-in happens (a dedicated domain goes to `signInHost`) |
| `src/signin.ts` | nonce and PKCE verifier in `sessionStorage` across the redirect, `/signin-state`, the authorize URL, the callback checks |
| `src/pkce.ts`, `src/encoding.ts` | PKCE `S256`, base64url, SHA-256 |
| `src/http.ts` | the slice of `fetch` and `Storage` the modules take as parameters, so they run in the browser and in Node tests |
| `src/token.ts` | the code exchange, the tenant claims, the tenant check |
| `src/exchange.ts` | the RFC 8693 exchange as a CORS simple request, retried after 1 s and 3 s |
| `src/api.ts` | `/api/*` calls with `x-amz-content-sha256` on `PUT` and `POST` |
| `src/stream.ts` | `text/event-stream` over `fetch` and a `ReadableStream` |
| `src/flow.ts` | the sign-in flow, with the browser effects passed in |
| `src/main.ts`, `src/agent-view.ts` | DOM glue; the agent view is a lazily imported chunk |

Everything but `main.ts` and `agent-view.ts` runs in Node, and
`test/spa/` tests it there. Tokens live in memory only. Every DOM write is
`textContent`, `append` of a string, or `createElement`, so the page runs
under Trusted Types with no policy. Switching tenant or signing out aborts
the calls the old session started and drops their late answers.

## Known limitations

- `main.ts` and `agent-view.ts` (the DOM glue) have no automated test;
  they are checked in a browser.
