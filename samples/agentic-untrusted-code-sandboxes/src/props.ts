// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/** Construct props (spec §3.3) and their synth-time validation. */

import { Duration } from 'aws-cdk-lib';
import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { BACKEND_NAMES, type BackendName } from './backend';
import type { BackendSettings } from './backend-construct';

export interface UntrustedCodeSandboxesProps {
  /** Deploy `runCodeFunction` for the vendor's own API (ADR-0017). @default false */
  readonly standalone?: boolean;
  /** The boundaries to deploy; at least one. @default ['microvm'] */
  readonly backends?: BackendName[];
  /** Used when a call names none. @default the first entry of `backends` */
  readonly defaultBackend?: BackendName;
  /** Runner kill time, 1 s to 60 s. @default 30 s */
  readonly runTimeout?: Duration;
  /** How long one call waits for a starting sandbox. @default 15 s */
  readonly startWait?: Duration;
  /** stdout and stderr together. @default 262144 */
  readonly maxOutputBytes?: number;
  /** Refuse larger inputs before any sandbox starts. @default 5242880 */
  readonly maxInputBytes?: number;
  /** Idle time before a sandbox is stopped or suspended. @default 15 min */
  readonly sandboxIdle?: Duration;
  /** Hard life cap on every backend. @default 8 h */
  readonly sandboxMaxLife?: Duration;
  /** EMF metrics with a TenantId dimension (ADR-0013). @default false */
  readonly perTenantMetrics?: boolean;
  /** Must have subnets tagged for the tool and the sandboxes. @default created (spec §3.7) */
  readonly vpc?: ec2.IVpc;
  /** Route 53 Resolver DNS Firewall (ADR-0016); refused with a supplied `vpc`. @default false */
  readonly dnsFirewall?: boolean | { readonly allowDomains?: string[] };
  /** Create the §3.7 sandbox endpoints. @default true */
  readonly createEndpoints?: boolean;
  /** The bucket with `inputs/<tenant>/`. @default created */
  readonly inputBucket?: s3.IBucket;
  readonly microvm?: { readonly memoryMiB?: number };
  readonly nitro?: { readonly cpu?: number; readonly memoryMiB?: number; readonly instanceTypes?: string[] };
  readonly agentcore?: { readonly sessionFiles?: boolean };
}

/** Props with defaults applied, after validation. */
export interface ResolvedProps {
  readonly standalone: boolean;
  readonly backends: readonly BackendName[];
  readonly defaultBackend: BackendName;
  readonly maxInputBytes: number;
  readonly perTenantMetrics: boolean;
  readonly dnsFirewall: false | { readonly allowDomains: readonly string[] };
  readonly createEndpoints: boolean;
  /** Tool Lambda timeout: 5 s + startWait + runTimeout + 10 s (spec §3.3). */
  readonly toolBudget: Duration;
  readonly settings: BackendSettings;
}

/** The core function's budget cap; the gateway entry checks its own 90 s cap (spec §3.3). */
export const CORE_BUDGET_CAP_SECONDS = 120;
export const GATEWAY_BUDGET_CAP_SECONDS = 90;

function fail(message: string): never {
  throw new Error(`UntrustedCodeSandboxes: ${message}`);
}

/** Apply defaults and fail at synth on every rule of spec §3.3. */
export function resolveProps(props: UntrustedCodeSandboxesProps): ResolvedProps {
  const backends = props.backends ?? ['microvm'];
  if (backends.length === 0) fail('backends must name at least one backend');
  for (const b of backends) {
    if (!BACKEND_NAMES.includes(b)) fail(`unknown backend "${String(b)}"; use ${BACKEND_NAMES.join(', ')}`);
  }
  if (new Set(backends).size !== backends.length) fail('backends lists a backend twice');
  const defaultBackend = props.defaultBackend ?? backends[0];
  if (!backends.includes(defaultBackend)) fail(`defaultBackend "${defaultBackend}" is not in backends`);

  const runTimeout = props.runTimeout ?? Duration.seconds(30);
  const startWait = props.startWait ?? Duration.seconds(15);
  const sandboxIdle = props.sandboxIdle ?? Duration.minutes(15);
  const sandboxMaxLife = props.sandboxMaxLife ?? Duration.hours(8);
  const runMs = runTimeout.toMilliseconds();
  if (runMs < 1000 || runMs > 60000) fail('runTimeout must be between 1 s and 60 s');
  if (startWait.toMilliseconds() < 0) fail('startWait must not be negative');
  const budget = 5 + startWait.toSeconds() + runTimeout.toSeconds() + 10;
  if (budget > CORE_BUDGET_CAP_SECONDS) {
    fail(`the tool budget 5 s + startWait + runTimeout + 10 s is ${budget} s, above ${CORE_BUDGET_CAP_SECONDS} s`);
  }
  if (sandboxMaxLife.toMilliseconds() > Duration.hours(8).toMilliseconds()) fail('sandboxMaxLife must be at most 8 h');
  if (sandboxIdle.toMilliseconds() < Duration.minutes(1).toMilliseconds()) fail('sandboxIdle must be at least 1 min');
  if (sandboxIdle.toMilliseconds() >= sandboxMaxLife.toMilliseconds()) fail('sandboxIdle must be below sandboxMaxLife');
  if (props.dnsFirewall && props.vpc) fail('dnsFirewall cannot be used with a supplied vpc (ADR-0016)');

  const positiveInt = (name: string, v: number) => {
    if (!Number.isInteger(v) || v <= 0) fail(`${name} must be a positive integer`);
    return v;
  };
  const maxOutputBytes = positiveInt('maxOutputBytes', props.maxOutputBytes ?? 262144);
  const maxInputBytes = positiveInt('maxInputBytes', props.maxInputBytes ?? 5242880);

  const dnsFirewall = props.dnsFirewall
    ? { allowDomains: typeof props.dnsFirewall === 'object' ? [...(props.dnsFirewall.allowDomains ?? [])] : [] }
    : false as const;

  return {
    standalone: props.standalone ?? false,
    backends: [...backends],
    defaultBackend,
    maxInputBytes,
    perTenantMetrics: props.perTenantMetrics ?? false,
    dnsFirewall,
    createEndpoints: props.createEndpoints ?? true,
    toolBudget: Duration.seconds(budget),
    settings: {
      runTimeout,
      startWait,
      maxOutputBytes,
      sandboxIdle,
      sandboxMaxLife,
      microvmMemoryMiB: positiveInt('microvm.memoryMiB', props.microvm?.memoryMiB ?? 1024),
      nitroCpu: positiveInt('nitro.cpu', props.nitro?.cpu ?? 512),
      nitroMemoryMiB: positiveInt('nitro.memoryMiB', props.nitro?.memoryMiB ?? 1024),
      // shortcut: the instance-type table and the per-architecture filter check
      // of spec §3.3 are the nitro backend's (src/backends/nitro.cdk.ts).
      nitroInstanceTypes: [...(props.nitro?.instanceTypes ?? ['m7i.xlarge'])],
      agentcoreSessionFiles: props.agentcore?.sessionFiles ?? false,
    },
  };
}
