// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Where `NodejsFunction` bundles from (ADR-0055). Without these two props it
 * looks for a lock file upward from the process working directory, so a
 * consumer app in another folder that constructs `ToolTarget` or
 * `SharedIngress` fails with `PathNotUnderRoot`: this package's entry files
 * are not under the consumer's project root. Every `NodejsFunction` in this
 * package spreads `bundlingRoot()`, so the root is the package's own directory
 * whatever the working directory is.
 */

import * as path from 'node:path';

/** This package's directory: `src/shared` and the compiled `lib/shared` are both two levels below it. */
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

/** `projectRoot` and `depsLockFilePath` for a `NodejsFunction` whose entry is a file of this package. */
export function bundlingRoot(): { projectRoot: string; depsLockFilePath: string } {
  return {
    projectRoot: PACKAGE_ROOT,
    depsLockFilePath: path.join(PACKAGE_ROOT, 'package-lock.json'),
  };
}
