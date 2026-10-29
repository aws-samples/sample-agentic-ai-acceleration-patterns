// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The backend interface, runtime side (spec §3.4, ADR-0011). The shared
 * ingress code produces a ValidatedRequest; a backend maps it onto its own
 * invoke call, unit-id transport and credential/user-token transport. The
 * ingress never sees anything backend-specific, and the backend never sees
 * the bearer token's raw `Authorization` value.
 *
 * The CDK-side half of the interface is in backend.cdk.ts.
 */

import type { VendedCredentials } from '../shared/tvm';

/** The backends the construct knows (spec §3.3). */
export type BackendKind = 'agentcore-runtime';

/** What the ingress hands the backend after every check has passed. */
export interface ValidatedRequest {
  /** From the verified token (P-3). */
  readonly tenantId: string;
  readonly sub: string;
  /** The isolation unit the ingress chose (P-2). */
  readonly unitId: string;
  /**
   * The backend name from the route (`/{backend}/invocations`) and the
   * Runtime ARN its registry entry names (ADR-0024). Chosen from the route
   * and the registry alone, never from the body or a header.
   */
  readonly backend: string;
  readonly runtimeArn: string;
  /** The caller's prompt, validated as a string. */
  readonly prompt: string;
  /** The user's token, only when `delegation.forwardUserToken` is on (P-5). */
  readonly userToken?: string;
  /** Tenant-scoped credentials, only when `tvm` is on (P-8). */
  readonly credentials?: VendedCredentials;
}

/** A backend's streamed answer. */
export interface BackendResponse {
  readonly contentType: string;
  readonly body: AsyncIterable<Uint8Array>;
}

/** A backend an ingress can invoke directly (the API Gateway integration Lambda). */
export interface InvokeBackend {
  invoke(request: ValidatedRequest): Promise<BackendResponse>;
}

/**
 * A backend whose unit id and credential/user-token transport are request
 * headers an intermediary writes (the AgentCore Gateway REQUEST interceptor).
 */
export interface HeaderTransportBackend {
  /** Every header the intermediary must set, unit id included; a client value is overwritten (P-2). */
  transportHeaders(request: ValidatedRequest): Record<string, string>;
}
