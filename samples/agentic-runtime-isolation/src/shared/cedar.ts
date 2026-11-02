// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The Cedar policy one `ToolTarget` writes into the tools gateway's policy
 * engine (spec §3.6, P-16; ADR-0034, ADR-0040). One policy per target, in
 * exactly the shape spike V-9 proved ACTIVE under `FAIL_ON_ANY_FINDINGS`
 * (spec §7.1):
 *
 * - the scope claim is read as `principal.getTag("scope")` (neither
 *   `principal.scope` nor `context.jwt.scope` validates);
 * - an entry matches as a whole space-separated token with four
 *   alternatives (`==`, `like "x *"`, `like "* x"`, `like "* x *"`);
 * - a literal `*` in `<target>/*` is written `\*` inside `like`.
 *
 * The same policy filters `tools/list` and refuses `tools/call`.
 */

import { TARGET_NAME_PATTERN, TOOL_SHORT_NAME_PATTERN } from './registry';

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
 * The four-way whole-entry match of `entry` against the scope tag. `entry`
 * is the literal for `==`; inside `like`, a `*` in the entry is escaped.
 */
function entryMatch(entry: string): string {
  const literal = entry;
  const pattern = entry.replace(/\*/g, '\\*');
  const tag = 'principal.getTag("scope")';
  return `(${tag} == "${literal}" || ${tag} like "${pattern} *" || ${tag} like "* ${pattern}" || ${tag} like "* ${pattern} *")`;
}

/**
 * The policy text for one target. `gatewayArn` may be a CDK token: it is only
 * interpolated. Target and tool names are checked against their patterns
 * first, so nothing but `[a-z0-9_-]` reaches the Cedar text.
 */
export function cedarPolicyFor(target: string, tools: readonly string[], gatewayArn: string): string {
  if (!TARGET_NAME_PATTERN.test(target)) {
    throw new Error(`cedarPolicyFor: target must match ${TARGET_NAME_PATTERN.source}`);
  }
  if (tools.length === 0) {
    throw new Error('cedarPolicyFor: a target needs at least one tool');
  }
  for (const tool of tools) {
    if (!TOOL_SHORT_NAME_PATTERN.test(tool)) {
      throw new Error(`cedarPolicyFor: tool must match ${TOOL_SHORT_NAME_PATTERN.source}`);
    }
  }
  const action = (tool: string) => `AgentCore::Action::"${gatewayToolName(target, tool)}"`;
  const perTool = tools.map((tool) => `(action == ${action(tool)} && ${entryMatch(`${target}/${tool}`)})`);
  return [
    'permit(',
    '  principal is AgentCore::OAuthUser,',
    `  action in [${tools.map(action).join(', ')}],`,
    `  resource == AgentCore::Gateway::"${gatewayArn}"`,
    ') when {',
    `  principal.hasTag("scope") && (${[entryMatch(`${target}/*`), ...perTool].join(' || ')})`,
    '};',
  ].join('\n');
}
