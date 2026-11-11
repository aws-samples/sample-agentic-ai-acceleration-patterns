// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * scripts/teardown-lib.sh `finish_memory_teardown` against a fake `aws` CLI:
 * a stack left DELETE_FAILED only by a Memory that AgentCore is still
 * deleting is finished with the Memory retained and polled; any other failure
 * retains nothing (README, Deployment integration test).
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const LIB = path.join(__dirname, '..', 'scripts', 'teardown-lib.sh');

// The fake CLI: answers from files in $FAKE_STATE and logs every call.
const FAKE_AWS = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_STATE/calls"
case "$1 $2" in
  "cloudformation describe-stacks") [[ -f "$FAKE_STATE/stack" ]] || exit 254; cat "$FAKE_STATE/stack" ;;
  "cloudformation describe-stack-resources") cat "$FAKE_STATE/failed" ;;
  "cloudformation delete-stack") rm -f "$FAKE_STATE/stack" ;;
  "cloudformation wait") exit 0 ;;
  "bedrock-agentcore-control get-memory")
    n=$(cat "$FAKE_STATE/deleting" 2>/dev/null || echo 0)
    if [[ "$n" -gt 0 ]]; then echo $((n - 1)) > "$FAKE_STATE/deleting"; exit 0; fi
    exit 254 ;;
  *) exit 99 ;;
esac
`;

interface Run {
  readonly code: number;
  readonly stderr: string;
  readonly calls: string[];
}

function run(state: { stack?: string; failed?: string; deleting?: number }, wait = 5, poll = 0): Run {
  const dir = mkdtempSync(path.join(tmpdir(), 'tmi-teardown-'));
  try {
    writeFileSync(path.join(dir, 'aws'), FAKE_AWS);
    chmodSync(path.join(dir, 'aws'), 0o755);
    if (state.stack !== undefined) writeFileSync(path.join(dir, 'stack'), `${state.stack}\n`);
    writeFileSync(path.join(dir, 'failed'), state.failed ?? '');
    writeFileSync(path.join(dir, 'deleting'), String(state.deleting ?? 0));
    writeFileSync(path.join(dir, 'calls'), '');
    const result = spawnSync('bash', ['-c', `source "${LIB}"; finish_memory_teardown Stack ${wait} ${poll}`], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_STATE: dir },
      encoding: 'utf8',
    });
    return { code: result.status ?? -1, stderr: result.stderr, calls: readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MEMORY_ROW = 'AWS::BedrockAgentCore::Memory\tTenantMemoryA1\tarn:aws:bedrock-agentcore:us-east-1:111122223333:memory/TenantMemory-abcdefghij\n';

describe('finish_memory_teardown', () => {
  it('retains a Memory still being deleted, deletes the stack, and waits for the service', () => {
    const result = run({ stack: 'DELETE_FAILED', failed: MEMORY_ROW, deleting: 2 });
    expect(result.code).toBe(0);
    expect(result.calls).toContain('cloudformation delete-stack --stack-name Stack --retain-resources TenantMemoryA1');
    expect(result.calls.filter((c) => c.startsWith('bedrock-agentcore-control get-memory --memory-id TenantMemory-abcdefghij'))).toHaveLength(3);
  });

  it('reports a Memory still deleting when the wait runs out, after the stack is gone', () => {
    const result = run({ stack: 'DELETE_FAILED', failed: MEMORY_ROW, deleting: 1000 }, 0);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('TenantMemory-abcdefghij is still being deleted by AgentCore');
    expect(result.calls).toContain('cloudformation delete-stack --stack-name Stack --retain-resources TenantMemoryA1');
  });

  it('retains nothing when another resource failed too', () => {
    const result = run({ stack: 'DELETE_FAILED', failed: `${MEMORY_ROW}AWS::IAM::Role\tGatewayRole\tGatewayRole-1\n` });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('GatewayRole (AWS::IAM::Role) failed to delete');
    expect(result.calls.some((c) => c.startsWith('cloudformation delete-stack'))).toBe(false);
  });

  it('leaves a stack in any other state alone', () => {
    const result = run({ stack: 'DELETE_IN_PROGRESS', failed: MEMORY_ROW });
    expect(result.code).toBe(1);
    expect(result.calls.some((c) => c.startsWith('cloudformation delete-stack'))).toBe(false);
  });

  it('succeeds at once when the stack is already gone', () => {
    const result = run({});
    expect(result.code).toBe(0);
    expect(result.calls).toEqual(['cloudformation describe-stacks --stack-name Stack --query Stacks[0].StackStatus --output text']);
  });
});
