// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/** The SPA build (spec §7.1, §7.2, §10 step 10; ADR-0008, ADR-0023). */

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import { buildSpa, CALLBACK_SCRIPT, checkImportMap, checkImports, CSP_HASH_ALG, cspHashes, digest, SpaBuild, SRI_ALG, writeSpa } from '../../spa/build';

const SAMPLE = path.join(__dirname, '..', '..');
let a: SpaBuild;
let b: SpaBuild;
let html: string;

beforeAll(async () => {
  [a, b] = await Promise.all([buildSpa(), buildSpa()]);
  html = a.files.get('index.html')!.toString('utf8');
}, 60_000);

function importMap(): { integrity: Record<string, string> } {
  return JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)![1]);
}

function entrySrc(): string {
  return /<script type="module" src="\/([^"]+)"/.exec(html)![1];
}

describe('SPA build output', () => {
  test('is deterministic: same input, same bytes (§7.1)', () => {
    expect([...a.files.keys()]).toEqual([...b.files.keys()]);
    for (const [k, v] of a.files) expect(v.equals(b.files.get(k)!)).toBe(true);
  });

  test('writes index.html, csp.json and content-hashed assets only (§7.2)', () => {
    for (const k of a.files.keys()) expect(k).toMatch(/^(index\.html|csp\.json|assets\/[A-Za-z0-9]+\.(js|css))$/);
    const css = [...a.files.keys()].filter((k) => k.endsWith('.css'));
    expect(css).toHaveLength(1);
    expect(css[0]).toBe(`assets/${createHash('sha256').update(a.files.get(css[0])!).digest('hex').slice(0, 16)}.css`);
  });

  test('the first element after <meta charset> is the inline callback script, then the import map (§7.1 Reports)', () => {
    const head = /<head>\s*<meta charset="utf-8">\s*(<script>[\s\S]*?<\/script>)\s*(<script type="importmap">)/.exec(html);
    expect(head).not.toBeNull();
    expect(head![1]).toBe(`<script>${CALLBACK_SCRIPT}</script>`);
    expect(html.indexOf('<script type="importmap">')).toBeLessThan(html.indexOf('<link'));
    expect(html.indexOf('<link')).toBeLessThan(html.indexOf('<script type="module"'));
  });

  test('csp.json holds the sha384 sources of the inline scripts and the entry, and an empty style-src (§7.1, ADR-0008)', () => {
    const csp = JSON.parse(a.files.get('csp.json')!.toString('utf8'));
    expect(Object.keys(csp)).toEqual(['script-src', 'style-src']);
    const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => `'${digest(CSP_HASH_ALG, m[1])}'`);
    expect(inline).toHaveLength(2);
    const entry = `'${digest(CSP_HASH_ALG, a.files.get(entrySrc())!)}'`;
    expect(csp['script-src']).toEqual([...inline, entry]);
    expect(csp['style-src']).toEqual([]);
    for (const s of csp['script-src']) expect(s).toMatch(/^'sha384-[A-Za-z0-9+/]{64}'$/);
    expect(csp).toEqual(a.csp);
  });

  test('the entry and stylesheet carry integrity that matches their bytes (§7.1 Imported chunks)', () => {
    expect(html).toContain(`src="/${entrySrc()}" integrity="${digest(CSP_HASH_ALG, a.files.get(entrySrc())!)}"`);
    const css = /<link rel="stylesheet" href="\/([^"]+)" integrity="([^"]+)">/.exec(html)!;
    expect(css[2]).toBe(digest(SRI_ALG, a.files.get(css[1])!));
  });

  test('the import map pins every chunk the entry can import, with sha384 matching the file (ADR-0023)', () => {
    const map = importMap();
    const chunks = [...a.files.keys()].filter((k) => k.endsWith('.js') && k !== entrySrc()).map((k) => `/${k}`);
    expect(chunks.length).toBeGreaterThan(0);
    expect(Object.keys(map.integrity).sort()).toEqual(chunks.sort());
    for (const url of chunks) expect(map.integrity[url]).toBe(digest(SRI_ALG, a.files.get(url.slice(1))!));
    const entry = a.files.get(entrySrc())!.toString('utf8');
    for (const url of chunks) expect(entry).toContain(`./${path.basename(url)}`);
  });

  test('has no inline handler, style attribute, inline style or HTML sink (§7.2, Trusted Types)', () => {
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/\sstyle\s*=|<style/i);
    for (const [k, v] of a.files) {
      if (k.endsWith('.js')) expect(v.toString('utf8')).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
    }
  });

  test('stores no token: sessionStorage is the only storage the bundle names (§3.5, ADR-0007)', () => {
    const js = [...a.files].filter(([k]) => k.endsWith('.js')).map(([, v]) => v.toString('utf8')).join('\n');
    expect(js).not.toMatch(/localStorage|document\.cookie|indexedDB/);
  });

  test('writeSpa writes the files byte for byte', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tfd-spa-'));
    writeSpa(a, out);
    for (const [k, v] of a.files) expect(fs.readFileSync(path.join(out, k)).equals(v)).toBe(true);
    fs.writeFileSync(path.join(out, 'assets', 'stale.js'), 'x');
    writeSpa(a, out);
    expect(fs.existsSync(path.join(out, 'assets', 'stale.js'))).toBe(false);
  });

  test('writeSpa refuses to clear a directory that holds no earlier build', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tfd-spa-'));
    fs.writeFileSync(path.join(out, 'keep.txt'), 'mine');
    expect(() => writeSpa(a, out)).toThrow('not clearing it');
    expect(fs.readFileSync(path.join(out, 'keep.txt'), 'utf8')).toBe('mine');
  });
});

describe('build checks (§7.1, §10 step 10)', () => {
  test('a chunk with no integrity entry fails the build', () => {
    const chunks = new Map([['/assets/AAAA.js', Buffer.from('x')], ['/assets/BBBB.js', Buffer.from('y')]]);
    const map = { integrity: { '/assets/AAAA.js': digest(SRI_ALG, Buffer.from('x')) } };
    expect(() => checkImportMap(map, chunks)).toThrow('/assets/BBBB.js has no integrity');
  });

  test('a chunk whose bytes changed fails the build', () => {
    const chunks = new Map([['/assets/AAAA.js', Buffer.from('changed')]]);
    expect(() => checkImportMap({ integrity: { '/assets/AAAA.js': digest(SRI_ALG, Buffer.from('x')) } }, chunks)).toThrow('does not match');
  });

  describe('checkImports (ADR-0023)', () => {
    const pinned = { '/assets/CHUNK.js': 'sha384-x' };
    const out = (p: string, kind = 'import-statement', external?: boolean) => ({
      'out/assets/ENTRY.js': { imports: [{ path: p, kind, external }] },
      'out/assets/x.css': { imports: [{ path: 'out/assets/NOPE.js', kind: 'import-statement' }] },
    });

    test('passes a static or dynamic import of a pinned chunk, or of the entry', () => {
      expect(() => checkImports(out('out/assets/CHUNK.js'), 'out', pinned, '/assets/ENTRY.js')).not.toThrow();
      expect(() => checkImports(out('out/assets/CHUNK.js', 'dynamic-import'), 'out', pinned, '/assets/ENTRY.js')).not.toThrow();
      expect(() => checkImports(out('out/assets/ENTRY.js'), 'out', pinned, '/assets/ENTRY.js')).not.toThrow();
    });

    test.each([
      ['an unpinned chunk', out('out/assets/OTHER.js')],
      ['an unpinned chunk with import()', out('out/assets/OTHER.js', 'dynamic-import')],
      ['an external URL', out('https://cdn.example.com/x.js', 'import-statement', true)],
    ])('fails on %s', (_n, outputs) => {
      expect(() => checkImports(outputs, 'out', pinned, '/assets/ENTRY.js')).toThrow('does not pin');
    });
  });

  test.each([
    ['an inline handler', '<button onclick="x()">'],
    ['a style attribute', '<p style="color:red">'],
    ['a javascript: URL', '<a href="javascript:x">'],
    ['an external script without integrity', '<script src="/a.js"></script>'],
    ['an external script with two integrity values', '<script src="/a.js" integrity="sha384-a sha384-b"></script>'],
    ['an external script whose integrity is not sha384', '<script src="/a.js" integrity="sha256-a"></script>'],
    ['an inline <style> (style-src \'self\')', '<style>p{}</style>'],
  ])('fails on %s', (_n, h) => {
    expect(() => cspHashes(h)).toThrow();
  });

  test('hashes an inline script whose end tag has whitespace, and checks an external one closed that way', () => {
    expect(cspHashes('<script>a()</script >')['script-src']).toEqual([`'${digest(CSP_HASH_ALG, 'a()')}'`]);
    expect(() => cspHashes('<script src="/a.js"></script\n>')).toThrow('integrity');
  });
});

describe('inline callback script (§3.5 step 4, §7.1 Reports)', () => {
  function run(search: string, pathname = '/callback'): { saved: unknown; replaced: unknown[][] } {
    const replaced: unknown[][] = [];
    const ctx: Record<string, unknown> = {
      location: { search, pathname },
      history: { replaceState: (...args: unknown[]) => void replaced.push(args) },
      URLSearchParams,
    };
    ctx.window = ctx;
    vm.runInNewContext(CALLBACK_SCRIPT, ctx);
    return { saved: ctx.__tfdCallbackQuery, replaced };
  }

  test.each(['?code=c&state=s', '?state=s', '?error=access_denied&error_description=x'])('saves %s and drops it from the address', (q) => {
    expect(run(q)).toEqual({ saved: q, replaced: [[null, '', '/callback']] });
  });

  test('leaves an address with no callback parameters alone', () => {
    expect(run('?x=1', '/')).toEqual({ saved: '?x=1', replaced: [] });
    expect(run('', '/')).toEqual({ saved: '', replaced: [] });
  });
});

test('spa/ type-checks against the DOM lib (spa/tsconfig.json)', () => {
  const tsc = path.join(SAMPLE, 'node_modules', '.bin', 'tsc');
  const r = spawnSync(tsc, ['-p', path.join(SAMPLE, 'spa', 'tsconfig.json'), '--noEmit'], { encoding: 'utf8' });
  expect(r.stdout + r.stderr).toBe('');
  expect(r.status).toBe(0);
}, 120_000);
