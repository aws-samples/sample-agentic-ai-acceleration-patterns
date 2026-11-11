// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The backend interface, runtime side (spec §3.4, ADR-0011). The shared
 * ingress code produces a ValidatedRequest; a backend maps it onto its own
 * invoke call, unit-id transport and credential/transaction-token transport. The
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
  /** The validated `conversationId`, when the `session` module is on (ADR-0002); handed to the agent so a delegation can stay in the conversation (ADR-0048). */
  readonly conversationId?: string;
  /**
   * (P-5, P-14) The transaction token the ingress minted for this request:
   * the only token the agent sees. Never the identity token.
   */
  readonly transactionToken?: string;
  /** (P-9) The token's `txn`, for log lines that join an agent request to its tool calls. */
  readonly txn?: string;
  /** (P-9) Entries in the token's `scope`. */
  readonly grantSize?: number;
  /** (P-9) Whether the token came from the mint cache. */
  readonly mint?: 'hit' | 'miss';
  /**
   * (P-9) True when the grant holds only the agent's needs. Set where
   * the request was minted (the `agentcore-gateway` interceptor); the
   * `api-gateway` authoriser logs it on its own `request authorised` line.
   */
  readonly noToolsGranted?: boolean;
  /** Tenant-scoped credentials, only when `tvm` is on (P-8). */
  readonly credentials?: VendedCredentials;
  /** (ADR-0048) On the delegation route: the calling agent, and the agents in the chain after this hop. */
  readonly delegatedFrom?: string;
  readonly depth?: number;
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
 * A backend whose unit id and credential/transaction-token transport are request
 * headers an intermediary writes (the AgentCore Gateway REQUEST interceptor).
 */
export interface HeaderTransportBackend {
  /** Every header the intermediary must set, unit id included; a client value is overwritten (P-2). */
  transportHeaders(request: ValidatedRequest): Record<string, string>;
}
