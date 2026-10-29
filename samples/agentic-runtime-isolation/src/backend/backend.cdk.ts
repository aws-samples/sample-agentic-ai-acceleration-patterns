// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The backend interface, CDK side (spec §3.4, ADR-0011). A backend owns its
 * isolation unit, its invoke call, its resource policy (P-1) and how the
 * unit id, the forwarded user token and the vended credentials reach it.
 * `AgentBackend` (src/agent-backend.cdk.ts) talks to the backend only
 * through this interface, so a later backend is a new implementation and a
 * new `backend` prop value, not a change to the ingress code. The ingress
 * itself never names a backend: it resolves one through the registry
 * (ADR-0024).
 *
 * The runtime-side half is in backend.ts.
 */

import type * as iam from 'aws-cdk-lib/aws-iam';
import type { IConstruct } from 'constructs';

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
  /**
   * Trusts exactly one principal (P-1): writes the resource policy that
   * allows the invoke call for the role at `ingressRoleArn` and denies
   * everyone else. The identity half is the ingress's tag-conditioned grant
   * (`SharedIngress`, ADR-0024). Called once; returns the policy resource
   * so the registry entry can depend on it.
   */
  bindIngress(ingressRoleArn: string): IConstruct;
}
