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
 * must carry the context key `rcIntegTest`, which only `createIntegApp` sets.
 */

import { CfnFunction, type Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';

export const INTEG_OVERRIDES_ENV = 'RC_INTEG_OVERRIDES';
export const INTEG_FAIL_START_TENANT_ENV = 'RC_INTEG_FAIL_START_TENANT';
/** The context key that marks an app as the integration app. */
export const INTEG_CONTEXT_KEY = 'rcIntegTest';

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
  if (fn.node.tryGetContext(INTEG_CONTEXT_KEY) !== true) {
    throw new Error(`${INTEG_OVERRIDES_ENV} may be set only in the integration app (context ${INTEG_CONTEXT_KEY}=true)`);
  }
  const cfn = fn.node.defaultChild;
  if (!(cfn instanceof CfnFunction)) throw new Error(`${fn.node.path} has no CfnFunction to override`);
  for (const [name, value] of Object.entries(overrideEnvironment(options))) {
    cfn.addPropertyOverride(`Environment.Variables.${name}`, value);
  }
}
