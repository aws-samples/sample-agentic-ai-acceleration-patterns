// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The Cedar policy one `ToolTarget` writes into its tools gateway's policy
 * engine (spec §3.6, P-16; ADR-0034, ADR-0040, ADR-0041). ONE star permit
 * per target, whatever its tool count, in the shape spike V-16a proved
 * ACTIVE under `FAIL_ON_ANY_FINDINGS` (spec §7.2):
 *
 * - the action is the target as an action group,
 *   `action in AgentCore::Action::"<target>"`, so no tool is named and the
 *   text stays about 450 bytes (per-tool permits hold 28 tools each and take
 *   2 to 3 minutes per policy to become ACTIVE; they are not used, ADR-0041);
 * - the scope claim is read as `principal.getTag("scope")`;
 * - `<target>/*` matches as a whole space-separated entry with four
 *   alternatives (`==`, `like "x *"`, `like "* x"`, `like "* x *"`), the
 *   literal `*` written `\*` inside `like`;
 * - any `<target>/<tool>` entry matches with two `like` alternatives: an
 *   entry at the start of the claim (`like "<target>/*"`) or after a space
 *   (`like "* <target>/*"`). The wildcard cannot reach into another target's
 *   name: `xcrm/a` does not start with `crm/`, and ` crm/` needs the space.
 *
 * Policy filters `tools/list` and refuses `tools/call` at target grain. The
 * per-tool decision inside a granted target is the REQUEST interceptor's
 * (src/tools/interceptor.function.ts); with `responseFilter` the RESPONSE
 * interceptor trims the list to the exact tools (ADR-0041).
 */

import { TARGET_NAME_PATTERN } from './registry';

/** `definition.cedar.statement` is 35 to 10,000 characters after the Gateway qualifies each action (V-16a). */
export const MAX_POLICY_STATEMENT_CHARS = 10_000;

/** The Gateway's own tool name for `<target>/<tool>` (spec §3.5). */
export function gatewayToolName(target: string, tool: string): string {
  return `${target}___${tool}`;
}

/** The catalogue name `<target>/<tool>` for a Gateway tool name, or undefined when it is not one. */
export function catalogueToolName(gatewayName: string): string | undefined {
  const match = /^([a-z0-9-]{1,32})___([a-z0-9_]{1,64})$/.exec(gatewayName);
  return match === null ? undefined : `${match[1]}/${match[2]}`;
}

/**
 * The scope test of one target's star permit. `target` is already checked
 * against `[a-z0-9-]`, so it holds no Cedar metacharacter and no `*`.
 */
function scopeMatch(target: string): string {
  const tag = 'principal.getTag("scope")';
  const star = `${target}/\\*`;
  return [
    // The whole entry `<target>/*`.
    `${tag} == "${target}/*"`,
    `${tag} like "${star} *"`,
    `${tag} like "* ${star}"`,
    `${tag} like "* ${star} *"`,
    // Any entry `<target>/<tool>`, at the start or after a space.
    `${tag} like "${target}/*"`,
    `${tag} like "* ${target}/*"`,
  ].join(' || ');
}

/**
 * Whether `statement` is exactly the star permit `cedarPolicyFor` writes for
 * some target and gateway, or why not. The policy custom resource accepts
 * nothing else (2026-11-04 red team): invoked directly with a hand-written
 * `Statement`, it would otherwise write any Cedar text, a blanket permit
 * included, to the engine.
 */
export function cedarPolicyProblem(statement: unknown): string | undefined {
  if (typeof statement !== 'string') {
    return 'Statement must be a string';
  }
  const target = /action in AgentCore::Action::"([^"]*)",/.exec(statement)?.[1];
  const gatewayArn = /resource == AgentCore::Gateway::"([^"]*)"/.exec(statement)?.[1];
  if (target === undefined || !TARGET_NAME_PATTERN.test(target)) {
    return 'Statement names no valid target';
  }
  if (gatewayArn === undefined || !/^arn:[a-z-]+:bedrock-agentcore:[a-z0-9-]+:\d{12}:gateway\/[A-Za-z0-9_-]+$/.test(gatewayArn)) {
    return 'Statement names no gateway ARN';
  }
  return statement === cedarPolicyFor(target, gatewayArn) ? undefined : 'Statement is not the star permit of one target (cedarPolicyFor)';
}

/**
 * The one star permit of a target. `gatewayArn` may be a CDK token: it is
 * only interpolated. The target name is checked first, so nothing but
 * `[a-z0-9-]` reaches the Cedar text.
 */
export function cedarPolicyFor(target: string, gatewayArn: string): string {
  if (!TARGET_NAME_PATTERN.test(target)) {
    throw new Error(`cedarPolicyFor: target must match ${TARGET_NAME_PATTERN.source}`);
  }
  return [
    'permit(',
    '  principal is AgentCore::OAuthUser,',
    `  action in AgentCore::Action::"${target}",`,
    `  resource == AgentCore::Gateway::"${gatewayArn}"`,
    ') when {',
    `  principal.hasTag("scope") && (${scopeMatch(target)})`,
    '};',
  ].join('\n');
}
