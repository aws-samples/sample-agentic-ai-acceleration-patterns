// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Builds the demo SPA into `build/spa/` (spec §7.1, §7.2, ADR-0008,
 * ADR-0023):
 *
 * - `assets/<content-hash>.js` and `.css`, so `/assets/*` can be immutable;
 * - `index.html` with, in this order at the top of `<head>`, the inline
 *   callback script, an import map whose `integrity` pins every chunk the
 *   entry can import, the stylesheet and the entry, both with `integrity`;
 * - `csp.json`, the `sha384` hash sources for `script-src` (and an empty
 *   `style-src`, since §7.1 fixes `style-src 'self'`), which the stack (S2)
 *   places into the rest of the §7.1 policy.
 *
 * Same input, same bytes. Run: `npx ts-node -P tsconfig.json spa/build.ts [outDir]`.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as esbuild from 'esbuild';

const SPA_DIR = __dirname;
const ENTRY = 'src/main.ts';
export const DEFAULT_OUT_DIR = path.join(SPA_DIR, '..', 'build', 'spa');

/**
 * The hash algorithm of `csp.json` (§7.1 `script-src 'sha384-…'`, ADR-0008) and of the entry's
 * `integrity`, which must match a hash in `script-src` (CSP3 §6.7.2.3).
 */
export const CSP_HASH_ALG = 'sha384';
/** The algorithm of the import map's `integrity` entries and the stylesheet's (ADR-0023). */
export const SRI_ALG = 'sha384';

/**
 * The first script of `<head>` (§7.1 Reports): saves the query for the
 * entry and drops the code and `state` from the address before the
 * document loads anything. Classic, inline, hashed.
 */
export const CALLBACK_SCRIPT =
  '(function(){var q=location.search;window.__tfdCallbackQuery=q;var p=new URLSearchParams(q);' +
  'if(p.has("code")||p.has("state")||p.has("error")){history.replaceState(null,"",location.pathname);}})();';

export interface CspHashes {
  readonly 'script-src': string[];
  /** Always empty: §7.1 fixes `style-src 'self'`, so the build refuses inline styles. */
  readonly 'style-src': string[];
}

export interface SpaBuild {
  /** Relative path (`index.html`, `assets/x.js`, `csp.json`) to bytes. */
  readonly files: ReadonlyMap<string, Buffer>;
  readonly csp: CspHashes;
}

export function digest(alg: string, data: string | Buffer): string {
  return `${alg}-${createHash(alg).update(data).digest('base64')}`;
}

/** Fails when an emitted chunk has no `integrity` entry in the import map (§7.1, §10 step 10). */
export function checkImportMap(importMap: { integrity: Record<string, string> }, chunks: ReadonlyMap<string, Buffer>): void {
  for (const [url, bytes] of chunks) {
    const want = importMap.integrity[url];
    if (want === undefined) throw new Error(`spa build: chunk ${url} has no integrity entry in the import map`);
    if (want !== digest(SRI_ALG, bytes)) throw new Error(`spa build: integrity of ${url} does not match its bytes`);
  }
}

/**
 * The hash sources of every inline `<script>` in `html`, plus the
 * `integrity` of each external script, which CSP3 matches against
 * `script-src`. Fails on what the §7.1 policy would refuse: an inline event
 * handler, a `style` attribute or `<style>` element (`style-src 'self'`), a
 * `javascript:` URL, or an external script with no `integrity` in
 * `CSP_HASH_ALG`.
 */
export function cspHashes(html: string): CspHashes {
  if (/<[^>]+\son[a-z]+\s*=/i.test(html)) throw new Error('spa build: inline event handler attribute');
  if (/<[^>]+\sstyle\s*=/i.test(html)) throw new Error('spa build: style attribute');
  if (/<style\b/i.test(html)) throw new Error("spa build: inline <style> (the policy is style-src 'self')");
  if (/javascript:/i.test(html)) throw new Error('spa build: javascript: URL');
  const script: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const [, attrs, body] = m;
    if (/\ssrc\s*=/i.test(attrs)) {
      const integrity = /\sintegrity="([^"]+)"/.exec(attrs)?.[1];
      if (integrity === undefined || !integrity.startsWith(`${CSP_HASH_ALG}-`) || /\s/.test(integrity)) {
        throw new Error('spa build: external script needs one integrity value in the CSP algorithm');
      }
      script.push(`'${integrity}'`);
    } else {
      script.push(`'${digest(CSP_HASH_ALG, body)}'`);
    }
  }
  return { 'script-src': script, 'style-src': [] };
}

function fill(template: string, slots: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(slots)) {
    const marker = `{{${k}}}`;
    if (out.split(marker).length !== 2) throw new Error(`spa build: index.html needs ${marker} exactly once`);
    out = out.replace(marker, () => v);
  }
  if (/\{\{\w+\}\}/.test(out)) throw new Error('spa build: unfilled slot in index.html');
  return out;
}

/** Builds in memory. */
export async function buildSpa(): Promise<SpaBuild> {
  const result = await esbuild.build({
    absWorkingDir: SPA_DIR,
    entryPoints: [ENTRY],
    tsconfig: 'tsconfig.json',
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    charset: 'utf8',
    outdir: 'out/assets',
    entryNames: '[hash]',
    chunkNames: '[hash]',
    metafile: true,
    write: false,
    logLevel: 'silent',
  });

  const outRoot = path.join(SPA_DIR, 'out');
  const files = new Map<string, Buffer>();
  const chunks = new Map<string, Buffer>();
  let entry: string | undefined;
  for (const f of [...result.outputFiles].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const rel = path.relative(outRoot, f.path).split(path.sep).join('/');
    if (!/^assets\/[A-Z0-9]+\.js$/.test(rel)) throw new Error(`spa build: unexpected output ${rel}`);
    const bytes = Buffer.from(f.contents);
    files.set(rel, bytes);
    const meta = result.metafile.outputs[path.relative(SPA_DIR, f.path).split(path.sep).join('/')];
    // A chunk loaded with `import()` is an entry point to esbuild too; only ENTRY is the page's.
    if (meta?.entryPoint === ENTRY) entry = rel;
    else chunks.set(`/${rel}`, bytes);
  }
  if (entry === undefined) throw new Error('spa build: no entry output');

  const css = fs.readFileSync(path.join(SPA_DIR, 'src', 'app.css'));
  const cssName = `assets/${createHash('sha256').update(css).digest('hex').slice(0, 16)}.css`;
  files.set(cssName, css);

  const importMap = {
    integrity: Object.fromEntries([...chunks].map(([url, bytes]) => [url, digest(SRI_ALG, bytes)])),
  };
  checkImportMap(importMap, chunks);

  const entryBytes = files.get(entry)!;
  const template = fs.readFileSync(path.join(SPA_DIR, 'index.html'), 'utf8');
  const html = fill(template, {
    callback: `<script>${CALLBACK_SCRIPT}</script>`,
    importmap: `<script type="importmap">${JSON.stringify(importMap)}</script>`,
    stylesheet: `<link rel="stylesheet" href="/${cssName}" integrity="${digest(SRI_ALG, css)}">`,
    entry: `<script type="module" src="/${entry}" integrity="${digest(CSP_HASH_ALG, entryBytes)}"></script>`,
  });
  const csp = cspHashes(html);
  files.set('index.html', Buffer.from(html, 'utf8'));
  files.set('csp.json', Buffer.from(`${JSON.stringify(csp, null, 2)}\n`, 'utf8'));
  return { files, csp };
}

/** Writes a build to `outDir`, replacing what was there. */
export function writeSpa(build: SpaBuild, outDir: string): void {
  fs.rmSync(outDir, { recursive: true, force: true });
  for (const [rel, bytes] of [...build.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const p = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, bytes);
  }
}

if (require.main === module) {
  const outDir = path.resolve(process.argv[2] ?? DEFAULT_OUT_DIR);
  buildSpa().then(
    (b) => {
      writeSpa(b, outDir);
      for (const [rel, bytes] of [...b.files].sort(([x], [y]) => (x < y ? -1 : 1))) console.log(`${String(bytes.length).padStart(8)}  ${rel}`);
      console.log(`spa build: ${outDir}`);
    },
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
