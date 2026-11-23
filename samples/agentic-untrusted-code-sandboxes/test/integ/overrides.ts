// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The test-only overrides (spec §8 `max-life`, `failed-start`, `forged`;
 * threat T-88, M-60).
 *
 * `RC_INTEG_OVERRIDES=1` on a function makes it honour two switches a real
 * deployment never offers: the reaper takes `maxLifeSeconds` from its event,
 * and the tool passes the runner an exit-at-boot flag for the one tenant named
 * in `RC_INTEG_FAIL_START_TENANT`. The variable is set here, through a CDK
 * escape hatch (a raw property override on the function), and nowhere in the
 * construct: no prop exposes it. This module is imported by the integration
 * app only, and refuses to run in any other app: the app it is called from
 * must have been registered by `markIntegApp`, which only `createIntegApp`
 * calls. The mark lives in this module, so no context value or command-line
 * flag can set it.
 */

import type { App } from 'aws-cdk-lib';
import { CfnFunction, type Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import { TEST_HOOK_ENV } from '../../src/env';

export const INTEG_OVERRIDES_ENV = TEST_HOOK_ENV.RC_INTEG_OVERRIDES;
export const INTEG_FAIL_START_TENANT_ENV = TEST_HOOK_ENV.RC_INTEG_FAIL_START_TENANT;
const integApps = new WeakSet<object>();

/** Registers the app as the integration app. Only `createIntegApp` calls it. */
export function markIntegApp(app: App): void {
  integApps.add(app);
}

export interface IntegOverrideOptions {
  /** The tenant whose sandboxes the tool starts with the exit-at-boot flag (tool functions only). */
  readonly failStartTenant?: string;
}

/** The environment variables the escape hatch writes; pure, so a test names them without synthesising. */
export function overrideEnvironment(options: IntegOverrideOptions = {}): Record<string, string> {
  const env: Record<string, string> = { [INTEG_OVERRIDES_ENV]: '1' };
  if (options.failStartTenant !== undefined) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(options.failStartTenant)) {
      throw new Error('failStartTenant must be a valid tenant id');
    }
    env[INTEG_FAIL_START_TENANT_ENV] = options.failStartTenant;
  }
  return env;
}

/**
 * Turns the overrides on for one function of the integration stack. Throws
 * when the function is not in the integration app, so copying this call into
 * a deployment fails at synth instead of weakening it.
 */
export function enableIntegOverrides(fn: LambdaFunction, options: IntegOverrideOptions = {}): void {
  if (!integApps.has(fn.node.root)) {
    throw new Error(`${INTEG_OVERRIDES_ENV} may be set only in the integration app`);
  }
  const cfn = fn.node.defaultChild;
  if (!(cfn instanceof CfnFunction)) throw new Error(`${fn.node.path} has no CfnFunction to override`);
  for (const [name, value] of Object.entries(overrideEnvironment(options))) {
    cfn.addPropertyOverride(`Environment.Variables.${name}`, value);
  }
}
