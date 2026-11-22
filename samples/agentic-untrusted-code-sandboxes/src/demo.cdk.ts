// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The demo stack: a thin wrapper that wires the construct (standard §4.5).
 * It publishes the construct's properties as the sample's one JSON parameter
 * (spec §6.3, ADR-0069); the construct writes no parameter.
 */

import { Stack, type StackProps } from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { BACKEND_NAMES, type BackendName } from './backend';
import { UntrustedCodeSandboxes } from './untrusted-code-sandboxes.cdk';

/** The sample's published parameter (ARCHITECTURE.md §5.1, spec §6.3). */
export const PUBLISHED_PARAMETER = '/application-plane/shared/code-sandbox/sandboxes';

export interface DemoStackProps extends StackProps {
  readonly backends: BackendName[];
  readonly standalone: boolean;
}

export class DemoStack extends Stack {
  public readonly sandboxes: UntrustedCodeSandboxes;

  public constructor(scope: Construct, id: string, props: DemoStackProps) {
    super(scope, id, props);
    const sandboxes = new UntrustedCodeSandboxes(this, 'Sandboxes', {
      backends: props.backends,
      standalone: props.standalone,
    });
    this.sandboxes = sandboxes;
    // One JSON document, not one parameter per value: Parameter Store allows 3 writes per second per account.
    const published = {
      version: 1,
      // The demo stack has no gateway entry; a vendor's app that adds a RunCodeToolTarget publishes its name here.
      toolTarget: 'none',
      runCodeFunctionArn: sandboxes.runCodeFunction?.functionArn ?? 'none',
      backends: [...sandboxes.config.backends],
      defaultBackend: sandboxes.config.defaultBackend,
      registryTableName: sandboxes.registryTable.tableName,
      inputBucketName: sandboxes.inputBucket.bucketName,
      offboardFunctionArn: sandboxes.offboardFunction.functionArn,
      ...sandboxes.backendOutputs,
    };
    new ssm.StringParameter(this, 'Published', {
      parameterName: PUBLISHED_PARAMETER,
      description: 'agentic-untrusted-code-sandboxes published interface (spec §6.3)',
      stringValue: this.toJsonString(published),
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
