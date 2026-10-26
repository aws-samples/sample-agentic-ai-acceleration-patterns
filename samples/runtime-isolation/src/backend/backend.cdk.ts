// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The backend interface, CDK side (spec §3.4, ADR-0011). A backend owns its
 * isolation unit, its invoke call, its resource policy (P-1) and how the
 * unit id, the forwarded user token and the vended credentials reach it.
 * The construct in src/runtime-isolation.cdk.ts talks to the backend only
 * through this interface, so a later backend is a new implementation and a
 * new `backend` prop value, not a change to the ingress code.
 *
 * The runtime-side half is in backend.ts.
 */

import type * as iam from 'aws-cdk-lib/aws-iam';

/** Which transports the deployer turned on; decides what the backend must accept. */
export interface BackendTransportOptions {
  /** `delegation.forwardUserToken` (P-5): the backend must accept the user-token transport. */
  readonly forwardUserToken: boolean;
  /** `tvm` set (P-8): the backend must accept the credential transport. */
  readonly tenantCredentials: boolean;
}

export interface IBackend {
  /** The backend's resource identifier (for `agentcore-runtime`, the Runtime ARN). */
  readonly resourceArn: string;
  /** The role the backend's code runs as; holds nothing tenant-scoped (P-6). */
  readonly executionRole: iam.IRole;
  /** Environment the ingress Lambdas need to reach this backend. */
  readonly ingressEnvironment: Record<string, string>;
  /**
   * Trusts exactly one principal (P-1): writes the resource policy that
   * allows the invoke call for `ingressRole` and denies everyone else, and
   * grants the matching identity permission. Called once.
   */
  bindIngress(ingressRole: iam.IRole): void;
}
