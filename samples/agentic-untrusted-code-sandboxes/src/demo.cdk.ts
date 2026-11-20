// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The demo stack: a thin wrapper that wires the construct (standard §4.5).
 * It publishes the construct's properties as the sample's parameters
 * (spec §6.3) once the core owner has built them.
 */

import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { BACKEND_NAMES, type BackendName } from './backend';
import { UntrustedCodeSandboxes } from './untrusted-code-sandboxes.cdk';

export interface DemoStackProps extends StackProps {
  readonly backends: BackendName[];
  readonly standalone: boolean;
}

export class DemoStack extends Stack {
  public readonly sandboxes: UntrustedCodeSandboxes;

  public constructor(scope: Construct, id: string, props: DemoStackProps) {
    super(scope, id, props);
    this.sandboxes = new UntrustedCodeSandboxes(this, 'Sandboxes', {
      backends: props.backends,
      standalone: props.standalone,
    });
  }
}

export interface DemoContext {
  readonly backends: BackendName[];
  readonly standalone: boolean;
}

function fail(message: string): never {
  throw new Error(`context: ${message}`);
}

/** Parse and check the demo app's context; exported for the unit test. */
export function readContext(get: (key: string) => unknown): DemoContext {
  const raw = get('backends');
  if (typeof raw !== 'string' || raw.trim() === '') {
    fail('--context backends=<microvm,nitro,agentcore> is required');
  }
  const backends = raw.split(',').map((s) => s.trim());
  for (const b of backends) {
    if (!(BACKEND_NAMES as readonly string[]).includes(b)) fail(`backends: unknown backend "${b}"`);
  }
  const bool = (key: string): boolean => {
    const v = get(key);
    if (v === true || v === 'true') return true;
    if (v === false || v === 'false') return false;
    return fail(`--context ${key}=true|false is required`);
  };
  return { backends: backends as BackendName[], standalone: bool('standalone') };
}
