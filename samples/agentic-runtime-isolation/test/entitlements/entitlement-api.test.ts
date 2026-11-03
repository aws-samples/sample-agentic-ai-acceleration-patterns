// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import * as path from 'node:path';
import { re2WasmPath } from '../../src/entitlements/entitlement-api.cdk';

describe('EntitlementApi bundling', () => {
  // Integ run 6: the Smithy server SDK's re2-wasm loads re2.wasm beside the
  // bundle at init; without the copy every entitlement route is a 502.
  test('re2.wasm resolves through @smithy/server-common and exists', () => {
    const wasm = re2WasmPath();
    expect(path.basename(wasm)).toBe('re2.wasm');
    expect(fs.statSync(wasm).size).toBeGreaterThan(0);
  });

  test('the re2-wasm loader looks for re2.wasm under that file name', () => {
    const loader = path.join(path.dirname(re2WasmPath()), 're2.js');
    expect(fs.readFileSync(loader, 'utf8')).toMatch(/wasmBinaryFile = ['"]re2\.wasm['"]/);
  });
});
