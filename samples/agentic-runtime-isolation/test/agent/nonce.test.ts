// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The per-VM nonce (spec C-2, ADR-0050). Runtime platform V2 restores every
 * microVM from one snapshot, so a value drawn at import would be the same in
 * every microVM. The nonce is drawn on the first request, from /dev/urandom.
 */
describe('nonce', () => {
  /** Loads a fresh copy of the agent module with `openSync` recorded. */
  function loadApp(): { app: typeof import('../../src/agent/app'); opened: string[] } {
    const opened: string[] = [];
    let app!: typeof import('../../src/agent/app');
    jest.isolateModules(() => {
      jest.doMock('node:fs', () => {
        const actual = jest.requireActual<typeof import('node:fs')>('node:fs');
        return {
          ...actual,
          openSync: (file: string, flags: string) => {
            opened.push(String(file));
            return actual.openSync(file, flags);
          },
        };
      });
      // A fresh module instance per test needs a synchronous require.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      app = require('../../src/agent/app');
    });
    return { app, opened };
  }

  afterEach(() => jest.dontMock('node:fs'));

  it('reads no random bytes at import', () => {
    const { opened } = loadApp();
    expect(opened).not.toContain('/dev/urandom');
  });

  it('draws 16 bytes once, on the first call, and keeps them for the process', () => {
    const { app } = loadApp();
    const read = jest.fn((size: number) => Buffer.alloc(size, 0xab));
    expect(app.nonce(read)).toBe('ab'.repeat(16));
    expect(app.nonce(read)).toBe('ab'.repeat(16));
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(16);
  });

  it('reads the default source from /dev/urandom', () => {
    const { app, opened } = loadApp();
    expect(app.urandom(16)).toHaveLength(16);
    expect(opened).toContain('/dev/urandom');
    expect(app.nonce()).toMatch(/^[0-9a-f]{32}$/);
  });
});
