// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * A harness for the sample's bash scripts (`hooks/route-hook.sh`,
 * `scripts/register-hooks.sh`): it runs a script with `bash` and puts stub
 * `curl`, `aws` and `sleep` commands first on `PATH`. The stubs answer from
 * files the test writes and record every call, the curl config file or
 * stdin and the request body, so a test can check what was sent, where and
 * how, without a network or AWS. `jq` and the coreutils are the real ones.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const SAMPLE_ROOT = path.join(__dirname, '..', '..');

const CURL_STUB = `#!/usr/bin/env bash
set -euo pipefail
n=$(( $(cat "$STUB_DIR/curl.count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$STUB_DIR/curl.count"
c="$STUB_DIR/curl.$n"
printf '%s\\n' "$@" > "$c.args"
out=""; cfg=""; data=""; url=""; method=GET; stdin_cfg=no
while (($#)); do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -K) cfg="$2"; shift 2 ;;
    --config) if [[ "$2" == - ]]; then stdin_cfg=yes; else cfg="$2"; fi; shift 2 ;;
    --data-binary) data="\${2#@}"; shift 2 ;;
    -X) method="$2"; shift 2 ;;
    -w|-H|--aws-sigv4|--connect-timeout|--max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s %s\\n' "$method" "$url" > "$c.request"
if [[ -n "$cfg" ]]; then cp "$cfg" "$c.config"; stat -c %a "$cfg" > "$c.mode"; fi
if [[ "$stdin_cfg" == yes ]]; then cat > "$c.config"; fi
if [[ -n "$data" ]]; then cp "$data" "$c.data"; stat -c %a "$data" > "$c.datamode"; fi
r="$STUB_DIR/resp.$n"
if [[ ! -f "$r.status" ]]; then echo "curl stub: no response $n" >&2; printf 000; exit 7; fi
status="$(cat "$r.status")"
if [[ "$status" == fail ]]; then echo "curl: (6) Could not resolve host: stub" >&2; printf 000; exit 6; fi
if [[ -n "$out" && -f "$r.body" ]]; then cp "$r.body" "$out"; fi
printf '%s' "$status"
`;

const AWS_STUB = `#!/usr/bin/env bash
set -euo pipefail
n=$(( $(cat "$STUB_DIR/aws.count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$STUB_DIR/aws.count"
printf '%s\\n' "$@" > "$STUB_DIR/aws.$n.args"
if [[ "$1 $2" == "configure export-credentials" ]]; then cat "$STUB_DIR/creds.json"; exit 0; fi
if [[ "$1 $2" == "ssm get-parameter" ]]; then
  m=$(( $(cat "$STUB_DIR/ssm.count" 2>/dev/null || echo 0) + 1 ))
  echo "$m" > "$STUB_DIR/ssm.count"
  if [[ -f "$STUB_DIR/ssm.$m.out" ]]; then cat "$STUB_DIR/ssm.$m.out"; exit 0; fi
  cat "$STUB_DIR/ssm.$m.err" >&2
  exit 254
fi
echo "aws stub: unexpected call $*" >&2
exit 2
`;

const SLEEP_STUB = `#!/usr/bin/env bash
echo "$1" >> "$STUB_DIR/sleeps"
`;

/** One response of the curl stub: an HTTP status and body, or `fail` for no answer. */
export type CurlResponse = { readonly status: number; readonly body?: unknown } | 'fail';

/** One answer of the aws stub's `ssm get-parameter`: the value, or an error text. */
export type SsmResponse = { readonly value: string } | { readonly error: string };

/** One recorded curl call. */
export interface CurlCall {
  readonly method: string;
  readonly url: string;
  readonly args: readonly string[];
  /** The `-K` file or the `--config -` stdin. */
  readonly config?: string;
  /** The `-K` file's mode, octal. */
  readonly configMode?: string;
  /** The `--data-binary @file` body. */
  readonly data?: string;
  readonly dataMode?: string;
}

export interface RunResult {
  readonly status: number | null;
  /** stdout and stderr together. */
  readonly output: string;
}

export class ScriptHarness {
  public readonly dir: string;
  private readonly bin: string;
  private curlCount = 0;
  private ssmCount = 0;

  constructor() {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfd-script-'));
    this.bin = path.join(this.dir, 'bin');
    fs.mkdirSync(this.bin);
    fs.writeFileSync(path.join(this.bin, 'curl'), CURL_STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(this.bin, 'aws'), AWS_STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(this.bin, 'sleep'), SLEEP_STUB, { mode: 0o755 });
  }

  /** Queues curl answers, in call order. */
  curl(...responses: CurlResponse[]): this {
    for (const r of responses) {
      this.curlCount += 1;
      const base = path.join(this.dir, `resp.${this.curlCount}`);
      if (r === 'fail') {
        fs.writeFileSync(`${base}.status`, 'fail');
      } else {
        fs.writeFileSync(`${base}.status`, String(r.status));
        if (r.body !== undefined) fs.writeFileSync(`${base}.body`, typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
      }
    }
    return this;
  }

  /** Queues `aws ssm get-parameter` answers, in call order. */
  ssm(...responses: SsmResponse[]): this {
    for (const r of responses) {
      this.ssmCount += 1;
      const base = path.join(this.dir, `ssm.${this.ssmCount}`);
      if ('value' in r) fs.writeFileSync(`${base}.out`, `${r.value}\n`);
      else fs.writeFileSync(`${base}.err`, `${r.error}\n`);
    }
    return this;
  }

  /** What `aws configure export-credentials --format process` prints. */
  credentials(creds: Record<string, unknown>): this {
    fs.writeFileSync(path.join(this.dir, 'creds.json'), JSON.stringify(creds));
    return this;
  }

  run(script: string, env: Record<string, string | undefined>, args: readonly string[] = []): RunResult {
    const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>;
    const r = spawnSync('bash', [script, ...args], {
      env: { PATH: `${this.bin}:${process.env.PATH}`, STUB_DIR: this.dir, TMPDIR: this.dir, ...clean },
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
  }

  curlCalls(): CurlCall[] {
    const calls: CurlCall[] = [];
    for (let n = 1; fs.existsSync(path.join(this.dir, `curl.${n}.request`)); n++) {
      const read = (suffix: string): string | undefined => {
        const f = path.join(this.dir, `curl.${n}.${suffix}`);
        return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined;
      };
      const [method, url] = read('request')!.trim().split(' ');
      calls.push({
        method,
        url,
        args: read('args')!.split('\n').filter((a) => a !== ''),
        config: read('config'),
        configMode: read('mode')?.trim(),
        data: read('data'),
        dataMode: read('datamode')?.trim(),
      });
    }
    return calls;
  }

  awsCalls(): string[][] {
    const calls: string[][] = [];
    for (let n = 1; fs.existsSync(path.join(this.dir, `aws.${n}.args`)); n++) {
      calls.push(fs.readFileSync(path.join(this.dir, `aws.${n}.args`), 'utf8').split('\n').filter((a) => a !== ''));
    }
    return calls;
  }

  sleeps(): number[] {
    const f = path.join(this.dir, 'sleeps');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map(Number) : [];
  }

  /** Files the script left in TMPDIR: its own temp directory must be gone. */
  leftovers(): string[] {
    return fs.readdirSync(this.dir).filter((f) => f.startsWith('tmp.'));
  }

  cleanup(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}
