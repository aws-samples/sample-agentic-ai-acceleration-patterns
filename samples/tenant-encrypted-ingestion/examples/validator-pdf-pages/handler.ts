// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Example custom validator: a page limit for PDFs (spec §3.5, ADR-0008).
 *
 * It holds no AWS permission. It fetches the one object it was given with
 * the presigned `objectUrl`, sending the `If-Match` the URL was signed with,
 * counts page objects (`/Type /Page`, not `/Pages`) and answers:
 *
 *   { "version": "1", "verdict": "ACCEPT" }
 *   { "version": "1", "verdict": "REJECT", "code": "TOO_MANY_PAGES", "message": "5 pages, limit 3" }
 *
 * The count is a byte scan, good enough for a sample and for uncompressed
 * object streams; a production validator would use a PDF parser. A
 * non-PDF delivery is accepted untouched (the structural checks already
 * matched its type). It never logs or stores the URL, and its `message`
 * names counts only, never document content.
 */

export interface ValidatorRequest {
  readonly version: string;
  readonly contentType: string;
  readonly objectUrl: string;
  readonly etag: string;
}

export type ValidatorVerdict = { version: '1'; verdict: 'ACCEPT' } | { version: '1'; verdict: 'REJECT'; code: string; message: string };

/** Page objects in a PDF's bytes. */
export function countPdfPages(bytes: Uint8Array): number {
  const text = Buffer.from(bytes).toString('latin1');
  return (text.match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length;
}

export function pageLimit(): number {
  const value = Number(process.env.PDF_PAGE_LIMIT ?? '300');
  return Number.isInteger(value) && value > 0 ? value : 300;
}

export async function validate(request: ValidatorRequest, fetchFn: typeof fetch): Promise<ValidatorVerdict> {
  if (request.version !== '1') {
    throw new Error('unsupported request version');
  }
  if (request.contentType !== 'application/pdf') {
    return { version: '1', verdict: 'ACCEPT' };
  }
  const response = await fetchFn(request.objectUrl, { headers: { 'If-Match': request.etag } });
  if (!response.ok) {
    throw new Error(`object fetch failed with HTTP ${response.status}`);
  }
  const pages = countPdfPages(new Uint8Array(await response.arrayBuffer()));
  const limit = pageLimit();
  if (pages > limit) {
    return { version: '1', verdict: 'REJECT', code: 'TOO_MANY_PAGES', message: `${pages} pages, limit ${limit}` };
  }
  return { version: '1', verdict: 'ACCEPT' };
}

/** The Lambda entry point. */
export async function handler(request: ValidatorRequest): Promise<ValidatorVerdict> {
  return validate(request, fetch);
}
