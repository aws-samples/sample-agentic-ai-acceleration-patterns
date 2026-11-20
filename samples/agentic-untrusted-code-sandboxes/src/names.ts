// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The resource-name sanitiser of spec §5.3. Every resource with an explicit
 * name gets it from the construct path through one rule per service: keep
 * the service's charset, truncate to its length, and end with 8 hex
 * characters of a hash of the path, so two instances in one account and
 * Region never collide. No aws-cdk-lib import.
 */

import { createHash } from 'node:crypto';
import type { NamedService } from './backend-construct';

interface NameRule {
  /** Characters that stay; every other run of characters becomes the separator. */
  readonly keep: RegExp;
  /** Replaces a run of dropped characters, and joins the hash. */
  readonly separator: string;
  readonly maxLength: number;
  readonly lowercase?: boolean;
  /** The name must start with a letter (AgentCore runtime names). */
  readonly startsWithLetter?: boolean;
  /** Prefixes the service refuses; one of these gets `fallbackPrefix` in front. */
  readonly reservedPrefixes?: readonly string[];
  readonly fallbackPrefix?: string;
}

const HASH_LENGTH = 8;

/** The charset and length per service, from spec §5.3. The kept charsets are the safe subsets of the documented ones. */
export const NAME_RULES: Readonly<Record<NamedService, NameRule>> = {
  'agentcore-runtime': { keep: /[a-zA-Z0-9_]/, separator: '_', maxLength: 48, startsWithLetter: true },
  'ecr-repository': { keep: /[a-z0-9-]/, separator: '-', maxLength: 256, lowercase: true },
  'ecs-cluster': { keep: /[a-zA-Z0-9_-]/, separator: '-', maxLength: 255 },
  'ecs-capacity-provider': {
    keep: /[a-zA-Z0-9_-]/,
    separator: '-',
    maxLength: 255,
    // ECS refuses capacity provider names that start with these.
    reservedPrefixes: ['aws', 'ecs', 'fargate'],
    fallbackPrefix: 'cp-',
  },
  'microvm-image': { keep: /[a-zA-Z0-9_-]/, separator: '-', maxLength: 64 },
  'network-connector': { keep: /[a-zA-Z0-9_-]/, separator: '-', maxLength: 64 },
  'log-group': { keep: /[a-zA-Z0-9_.#-]/, separator: '-', maxLength: 512 },
  'log-delivery': { keep: /[a-zA-Z0-9_-]/, separator: '-', maxLength: 60 },
  'contributor-insights-rule': { keep: /[a-zA-Z0-9_-]/, separator: '-', maxLength: 128 },
  'resolver': { keep: /[a-zA-Z0-9_-]/, separator: '-', maxLength: 64 },
  'logs-resource-policy': { keep: /[a-zA-Z0-9_-]/, separator: '-', maxLength: 255 },
};

/** Charset and length each service accepts, as a full-match pattern, for the unit tests and the synth test. */
export const NAME_PATTERNS: Readonly<Record<NamedService, RegExp>> = {
  'agentcore-runtime': /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/,
  'ecr-repository': /^[a-z0-9._/-]{1,256}$/,
  'ecs-cluster': /^[a-zA-Z0-9_-]{1,255}$/,
  'ecs-capacity-provider': /^[a-zA-Z0-9_-]{1,255}$/,
  'microvm-image': /^[a-zA-Z0-9_-]{1,64}$/,
  'network-connector': /^[a-zA-Z0-9_-]{1,64}$/,
  'log-group': /^[\w./#-]{1,512}$/,
  'log-delivery': /^[\w-]{1,60}$/,
  'contributor-insights-rule': /^[a-zA-Z0-9_-]{1,128}$/,
  'resolver': /^[\w-]{1,64}$/,
  'logs-resource-policy': /^[\w-]{1,255}$/,
};

/**
 * The name for one resource of one service. `path` is the construct path of
 * the core construct (`node.path`, stack included); `suffix` says which
 * resource of that service it is, and is part of the readable name and of
 * the hash.
 */
export function nameFor(path: string, service: NamedService, suffix: string): string {
  const rule = NAME_RULES[service];
  const hash = createHash('sha256').update(`${path}\u0000${service}\u0000${suffix}`).digest('hex').slice(0, HASH_LENGTH);
  const sep = rule.separator;
  let base = `${path}/${suffix}`;
  if (rule.lowercase) base = base.toLowerCase();
  // Each run of characters the service refuses becomes one separator.
  let kept = '';
  for (const ch of base) kept += rule.keep.test(ch) ? ch : sep;
  kept = kept.replace(new RegExp(`${escapeForClass(sep)}{2,}`, 'g'), sep);
  kept = trimEdges(kept, sep);
  if (rule.startsWithLetter && !/^[a-zA-Z]/.test(kept)) kept = `r${sep}${kept}`;
  if (rule.reservedPrefixes?.some((p) => kept.toLowerCase().startsWith(p))) kept = `${rule.fallbackPrefix}${kept}`;
  const room = rule.maxLength - HASH_LENGTH - sep.length;
  if (kept.length > room) kept = trimEdges(kept.slice(0, room), sep);
  return kept === '' ? `${service.replace(/-/g, sep)}${sep}${hash}` : `${kept}${sep}${hash}`;
}

/** A `NameFor` bound to the core construct's path (spec §5.3). */
export function makeNameFor(path: string): (service: NamedService, suffix: string) => string {
  return (service, suffix) => nameFor(path, service, suffix);
}

function escapeForClass(ch: string): string {
  return ch === '-' ? '\\-' : ch;
}

function trimEdges(s: string, sep: string): string {
  let out = s;
  while (out.startsWith(sep)) out = out.slice(sep.length);
  while (out.endsWith(sep)) out = out.slice(0, -sep.length);
  return out;
}
