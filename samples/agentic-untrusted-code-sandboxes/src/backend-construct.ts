// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The CDK seam between the core construct and each backend (ADR-0025).
 * `UntrustedCodeSandboxes` builds the shared parts (network, registry,
 * bucket, roles, functions) and asks each enabled backend, through this
 * interface, for its own resources, statements, endpoints, environment and
 * drain order. Each backend fills only its own `src/backends/<name>.cdk.ts`.
 */

import type { Duration } from 'aws-cdk-lib';
import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as ecr from 'aws-cdk-lib/aws-ecr';
import type * as iam from 'aws-cdk-lib/aws-iam';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct, IConstruct } from 'constructs';
import type { BackendName } from './backend';

/** Sandbox endpoints of spec §3.7 a backend needs. The core creates each once, for every backend that asks. */
export type SandboxEndpoint = 's3-gateway' | 'ecr-api' | 'ecr-dkr' | 'logs';

/** Per-service name sanitiser of spec §5.3, owned by the core. */
export type NameFor = (service: NamedService, suffix: string) => string;

/** Services with an explicit name (spec §5.3 names table). */
export type NamedService =
  | 'agentcore-runtime'
  | 'ecr-repository'
  | 'ecs-cluster'
  | 'ecs-capacity-provider'
  | 'microvm-image'
  | 'network-connector'
  | 'log-group'
  | 'log-delivery'
  | 'contributor-insights-rule'
  | 'resolver'
  | 'logs-resource-policy';

/** What the core hands a backend when it builds it. */
export interface BackendContext {
  readonly vpc: ec2.IVpc;
  /** Dead-end sandbox subnets (spec §3.7). */
  readonly sandboxSubnets: ec2.SubnetSelection;
  /** Tool subnets, routed through the NAT. */
  readonly toolSubnets: ec2.SubnetSelection;
  /** The tool security group; a backend admits it where the spec says (nitro task 8443). */
  readonly toolSecurityGroup: ec2.ISecurityGroup;
  readonly inputBucket: s3.IBucket;
  /** The construct-owned runner repository (ADR-0024); the core creates it when a container backend is enabled. */
  readonly runnerRepository?: ecr.IRepository;
  /** Image tag of the runner in `runnerRepository` per architecture, set by the core's image copy (ADR-0024). */
  readonly runnerImageTag?: (arch: 'arm64' | 'amd64') => string;
  /** Path of the runner sources (runnerPath() from handler-entry.ts). */
  readonly runnerDir: string;
  readonly nameFor: NameFor;
  readonly settings: BackendSettings;
}

/** The construct props a backend reads (spec §3.3), already validated by the core. */
export interface BackendSettings {
  readonly runTimeout: Duration;
  readonly startWait: Duration;
  readonly maxOutputBytes: number;
  readonly sandboxIdle: Duration;
  readonly sandboxMaxLife: Duration;
  readonly microvmMemoryMiB: number;
  readonly nitroCpu: number;
  readonly nitroMemoryMiB: number;
  readonly nitroInstanceTypes: readonly string[];
  readonly agentcoreSessionFiles: boolean;
}

/** One backend's CDK resources, as the core consumes them. */
export interface BackendConstruct {
  readonly name: BackendName;
  /** Statements for the shared tool role (spec §3.6 "Tool role"). */
  toolStatements(): iam.PolicyStatement[];
  /** Statements for the tool tenant role (`nitro` only: RunTask, TagResource, StopTask, PassRole). */
  tenantStatements(): iam.PolicyStatement[];
  /** Statements for the reaper role, which the offboard function also runs as. */
  reaperStatements(): iam.PolicyStatement[];
  /** Statements the drain role holds on top of the reaper role's. */
  drainStatements(): iam.PolicyStatement[];
  /** Sandbox endpoints this backend needs (spec §3.7 "Present when"). */
  endpoints(): SandboxEndpoint[];
  /**
   * Statements this backend needs in the policy of one sandbox endpoint (spec §3.7 "Policy allows").
   * The core merges the statements of every backend that asks for the endpoint, so a shared endpoint
   * (Logs) carries each backend's resources. Each statement names a principal of `*` and only this
   * backend's own repository, bucket prefix or log groups. Optional: a backend without it adds none.
   */
  endpointStatements?(endpoint: SandboxEndpoint): iam.PolicyStatement[];
  /** Security groups the endpoints admit on 443 (spec §3.7 "Endpoints" row). */
  endpointClients(): ec2.ISecurityGroup[];
  /** Function environment for the tool, reaper, drain and offboard functions; read by the run-time backend class. */
  environment(): Record<string, string>;
  /**
   * Resources the drain must stop sandboxes before (cluster, capacity
   * provider, runtime, image). The core makes the drain depend on each of
   * these, so CloudFormation deletes the drain, which runs on delete, before
   * them (spec §5.3). The log cleanup resource is made a dependency of each,
   * so it is deleted after them.
   */
  drainOrder(): IConstruct[];
  /** Log group names or prefixes the log cleanup resource deletes after the backend (spec §5.3). */
  logCleanup(): { readonly prefixes: string[]; readonly names: string[] };
  /** Read-only values the core exposes per backend (spec §3.3: image ARN, cluster ARN or runtime ARN), by name. */
  outputs(): Record<string, string>;
}

/** Each `src/backends/<name>.cdk.ts` exports one factory of this shape. */
export type BackendFactory = (scope: Construct, id: string, ctx: BackendContext) => BackendConstruct;
