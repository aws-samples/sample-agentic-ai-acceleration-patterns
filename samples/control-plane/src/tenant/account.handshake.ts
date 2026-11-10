// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { provisioningRoleArn, ProvisioningRoleKind, sessionNameFor } from '../shared/fleet';

/** One half of the pair that failed a handshake check, and why. */
export interface HandshakeRefusal {
  readonly kind: ProvisioningRoleKind;
  readonly roleArn: string;
  /** A complete clause, e.g. `could not be assumed (AccessDenied: …)` or `does not require the external id (…)`. */
  readonly reason: string;
}

/**
 * STS could not answer the probe for a reason that is not a trust-policy
 * refusal (throttling, a network fault, a 5xx). The handshake is unknown,
 * not refused: the caller reports a server-side error and the operator
 * retries, instead of being told to reinstall a pair that may be fine.
 */
export class HandshakeUnavailableError extends Error {
  constructor(
    readonly roleArn: string,
    readonly cause: unknown,
  ) {
    super(`Handshake probe of ${roleArn} failed: ${describe(cause)}`);
    this.name = 'HandshakeUnavailableError';
  }
}

/**
 * Verifies an account's handshake (spec R-26, ADR-027, ADR-030): assumes
 * both roles of the provisioning role pair with the supplied external id
 * and discards the credentials; when an external id is supplied, also
 * assumes each role *without* it and requires that call to be refused, so
 * a pair whose trust policy does not condition on `sts:ExternalId` is
 * caught at registration. Returns the refusals, empty when the handshake
 * is good; throws {@link HandshakeUnavailableError} when STS fails for a
 * reason other than a refusal. The probe makes no call under the assumed
 * credentials and writes nothing in the account (N-9); the session name is
 * the operator id (M23), so the account owner's CloudTrail shows who
 * registered the account.
 */
export type HandshakeProbe = (params: {
  readonly accountId: string;
  readonly externalId?: string;
  readonly operatorId: string;
}) => Promise<HandshakeRefusal[]>;

/** Session policy on every probe AssumeRole: the returned credentials may do nothing (T30). */
export const PROBE_SESSION_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [{ Effect: 'Deny', Action: '*', Resource: '*' }],
});

/** STS answers a trust-policy refusal (missing role, wrong principal, wrong or missing external id) with this code. */
const ACCESS_DENIED = 'AccessDenied';

type ProbeOutcome = { readonly assumed: true } | { readonly assumed: false; readonly reason: string };

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
}

/** The real probe, bound to the deployment's partition and fleet name. */
export function stsHandshakeProbe(
  sts: STSClient,
  partition: string,
  fleetName: string,
): HandshakeProbe {
  const assume = async (roleArn: string, operatorId: string, externalId: string | undefined): Promise<ProbeOutcome> => {
    try {
      await sts.send(
        new AssumeRoleCommand({
          RoleArn: roleArn,
          RoleSessionName: sessionNameFor(operatorId),
          ExternalId: externalId,
          // The minimum STS allows: the credentials are never used.
          DurationSeconds: 900,
          // A deny-all session policy (T30): the probe's credentials can do
          // nothing even if they were captured. The trust-policy check is
          // unaffected — STS evaluates the trust before the session policy.
          Policy: PROBE_SESSION_POLICY,
        }),
      );
      return { assumed: true };
    } catch (error) {
      if (error instanceof Error && error.name === ACCESS_DENIED) {
        return { assumed: false, reason: describe(error) };
      }
      throw new HandshakeUnavailableError(roleArn, error);
    }
  };

  return async ({ accountId, externalId, operatorId }) => {
    const refusals: HandshakeRefusal[] = [];
    for (const kind of ['cell', 'tenant'] as const) {
      const roleArn = provisioningRoleArn(partition, accountId, fleetName, kind);

      // Positive check: the pair admits this control plane with the external
      // id the operator supplied (R-26).
      const withId = await assume(roleArn, operatorId, externalId);
      if (!withId.assumed) {
        refusals.push({ kind, roleArn, reason: `could not be assumed (${withId.reason})` });
        continue;
      }

      // Negative check (ADR-030): STS accepts an ExternalId against a trust
      // policy that never conditions on it, so success above does not prove
      // the pair REQUIRES the id. Assume once more without it: that call
      // must be refused, or the owner's consent check is not in place.
      if (externalId !== undefined) {
        const withoutId = await assume(roleArn, operatorId, undefined);
        if (withoutId.assumed) {
          refusals.push({
            kind,
            roleArn,
            reason: 'does not require the external id (its trust policy has no sts:ExternalId condition; redeploy the pair with externalId)',
          });
        }
      }
    }
    return refusals;
  };
}
