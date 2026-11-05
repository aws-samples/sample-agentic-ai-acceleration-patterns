// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Structural checks (M-9), the verdict schema (M-21) and the example
 * validator (spec §3.5): one case per reason code, malformed verdicts are
 * never ACCEPT, the PDF page counter.
 */

import { Readable } from 'node:stream';
import { countPdfPages, validate } from '../examples/validator-pdf-pages/handler';
import { contentProblem, detectType, digestStream, headProblem, zipProblem } from '../src/processor/structural';
import { parseVerdict } from '../src/processor/verdict';

const KEY = 'arn:aws:kms:eu-central-1:111122223333:key/k';
const expected = { keyArn: KEY, declaredSizeBytes: 10, maxObjectSizeBytes: 100 };
const head = { ServerSideEncryption: 'aws:kms' as const, SSEKMSKeyId: KEY, BucketKeyEnabled: false, ContentLength: 10 };

/** A minimal stored ZIP with the given entry names. */
function zip(names: string[], uncompressed = 5): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const n = Buffer.from(name);
    const local = Buffer.alloc(30 + n.length + 5);
    local.writeUInt32LE(0x04034b50, 0);
    n.copy(local, 30);
    local.writeUInt16LE(n.length, 26);
    locals.push(local);
    const central = Buffer.alloc(46 + n.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(5, 20);
    central.writeUInt32LE(uncompressed, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    n.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe('headProblem (step 3)', () => {
  it('passes a matching drop', () => expect(headProblem(head, expected)).toBeUndefined());
  it.each([
    ['KEY_MISMATCH', { SSEKMSKeyId: `${KEY}x` }],
    ['KEY_MISMATCH', { BucketKeyEnabled: true }],
    ['KEY_MISMATCH', { ServerSideEncryption: 'AES256' }],
    ['STORAGE_CLASS', { StorageClass: 'GLACIER' }],
    ['TOO_LARGE', { ContentLength: 101 }],
    ['SIZE_MISMATCH', { ContentLength: 9 }],
  ])('%s for %j', (code, overrides) => expect(headProblem({ ...head, ...overrides } as never, expected)).toBe(code));
});

describe('content checks (step 4)', () => {
  it('detects the five supported types by magic bytes', () => {
    expect(detectType(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(detectType(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe('application/zip');
    expect(detectType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(detectType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectType(Buffer.from([0x49, 0x49, 0x2a, 0x00]))).toBe('image/tiff');
    expect(detectType(Buffer.from('hello'))).toBeUndefined();
  });

  it('hashes, measures and windows the stream in one pass', async () => {
    const digest = await digestStream(Readable.from([Buffer.from('%PDF-'), Buffer.from('rest')]));
    expect(digest.sizeBytes).toBe(9);
    expect(digest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(digest.head.toString()).toBe('%PDF-rest');
  });

  it('UNSUPPORTED_TYPE, TYPE_MISMATCH and BAD_ARCHIVE', async () => {
    const pdf = await digestStream(Readable.from([Buffer.from('%PDF-1.7 body')]));
    expect(contentProblem(pdf, 'application/pdf', ['application/pdf'])).toBeUndefined();
    expect(contentProblem(pdf, 'image/png', ['application/pdf'])).toBe('UNSUPPORTED_TYPE');
    expect(contentProblem(pdf, 'application/zip', ['application/pdf', 'application/zip'])).toBe('TYPE_MISMATCH');
    const bad = await digestStream(Readable.from([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0])]));
    expect(contentProblem(bad, 'application/zip', ['application/zip'])).toBe('BAD_ARCHIVE');
    const good = await digestStream(Readable.from([zip(['a.txt', 'dir/b.txt'])]));
    expect(contentProblem(good, 'application/zip', ['application/zip'])).toBeUndefined();
  });

  it('refuses a ZIP entry that escapes its root, and an expansion bomb', () => {
    const slip = zip(['../evil']);
    expect(zipProblem(slip, slip.length)).toMatch(/escapes/);
    const bomb = zip(['a'], 0xfffffffe);
    expect(zipProblem(bomb, bomb.length)).toMatch(/expands/);
  });
});

describe('parseVerdict (M-21)', () => {
  it('accepts the two documented shapes', () => {
    expect(parseVerdict({ version: '1', verdict: 'ACCEPT' })).toEqual({ verdict: 'ACCEPT' });
    expect(parseVerdict({ version: '1', verdict: 'REJECT', code: 'TOO_MANY_PAGES', message: '412 pages, limit 300' })).toEqual({
      verdict: 'REJECT',
      code: 'TOO_MANY_PAGES',
      message: '412 pages, limit 300',
    });
  });
  it.each([
    ['empty', {}],
    ['null', null],
    ['a string', 'ACCEPT'],
    ['an array', [{ version: '1', verdict: 'ACCEPT' }]],
    ['another version', { version: '2', verdict: 'ACCEPT' }],
    ['an extra field on ACCEPT', { version: '1', verdict: 'ACCEPT', note: 'x' }],
    ['a code on ACCEPT', { version: '1', verdict: 'ACCEPT', code: 'X' }],
    ['REJECT without code', { version: '1', verdict: 'REJECT' }],
    ['a lower-case code', { version: '1', verdict: 'REJECT', code: 'too_many' }],
    ['a code of 41 characters', { version: '1', verdict: 'REJECT', code: 'A'.repeat(41) }],
    ['an extra field on REJECT', { version: '1', verdict: 'REJECT', code: 'X', extra: 1 }],
    ['an unknown verdict', { version: '1', verdict: 'MAYBE' }],
  ])('is invalid for %s (never ACCEPT)', (_name, value) => expect(parseVerdict(value)).toBeUndefined());
});

describe('example validator: pdf-pages', () => {
  const pdf = (pages: number) =>
    Buffer.from(`%PDF-1.7\n1 0 obj << /Type /Pages /Count ${pages} >> endobj\n${'2 0 obj << /Type /Page >> endobj\n'.repeat(pages)}%%EOF`);

  it('counts /Type /Page and not /Type /Pages', () => {
    expect(countPdfPages(pdf(5))).toBe(5);
  });

  it('rejects over the limit with a message of counts only, sending If-Match', async () => {
    process.env.PDF_PAGE_LIMIT = '3';
    const fetchFn = jest.fn(async () => new Response(pdf(5)));
    const verdict = await validate(
      { version: '1', contentType: 'application/pdf', objectUrl: 'https://example.com/x', etag: '"e"' },
      fetchFn as unknown as typeof fetch,
    );
    expect(verdict).toEqual({ version: '1', verdict: 'REJECT', code: 'TOO_MANY_PAGES', message: '5 pages, limit 3' });
    expect(fetchFn).toHaveBeenCalledWith('https://example.com/x', { headers: { 'If-Match': '"e"' } });
    expect(parseVerdict(verdict)).toBeDefined();
  });

  it('accepts within the limit and passes non-PDFs untouched', async () => {
    process.env.PDF_PAGE_LIMIT = '3';
    const fetchFn = jest.fn(async () => new Response(pdf(2)));
    expect(await validate({ version: '1', contentType: 'application/pdf', objectUrl: 'u', etag: 'e' }, fetchFn as never)).toEqual({ version: '1', verdict: 'ACCEPT' });
    expect(await validate({ version: '1', contentType: 'image/png', objectUrl: 'u', etag: 'e' }, fetchFn as never)).toEqual({ version: '1', verdict: 'ACCEPT' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('throws (a validator error) when the fetch fails', async () => {
    const fetchFn = jest.fn(async () => new Response('', { status: 412 }));
    await expect(validate({ version: '1', contentType: 'application/pdf', objectUrl: 'u', etag: 'e' }, fetchFn as never)).rejects.toThrow(/412/);
  });
});
