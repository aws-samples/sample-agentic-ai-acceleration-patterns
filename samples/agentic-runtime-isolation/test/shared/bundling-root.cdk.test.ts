// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { GATEWAY_TARGET_NAME, SharedIngress, ToolTarget } from '../../src/index';
import { bundlingRoot } from '../../src/shared/bundling-root.cdk';

/**
 * A consumer app in another folder constructs `ToolTarget` and `SharedIngress`
 * (ADR-0055). `NodejsFunction` finds a lock file from the working directory
 * unless told where it is, and fails with `PathNotUnderRoot` when this
 * package's entry files are not under it. The constructs pass their own
 * package directory, so the working directory does not matter.
 */
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const DISCOVERY_URL = 'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_TESTPOOL00/.well-known/openid-configuration';
const OPENAPI = JSON.stringify({
  openapi: '3.0.1',
  info: { title: 'crm', version: '1' },
  paths: { '/cases': { get: { operationId: 'list_cases' } } },
});

function synthFrom(cwd: string): Template {
  const before = process.cwd();
  process.chdir(cwd);
  try {
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const stack = new Stack(app, 'Consumer', { env: { account: '111122223333', region: 'eu-central-1' } });
    const ingress = new SharedIngress(stack, 'Ingress', {
      ingress: 'api-gateway',
      identity: { discoveryUrl: DISCOVERY_URL, allowedClientIds: ['client-one'] },
      defaultBackend: GATEWAY_TARGET_NAME,
    });
    new ToolTarget(stack, 'Target', {
      name: 'ext',
      ingress,
      tools: [{ name: 'list_cases', description: 'Lists cases' }],
      kind: 'openApi',
      spec: { inlinePayload: OPENAPI },
      outboundAuth: {
        oauth: {
          providerArn: 'arn:aws:bedrock-agentcore:eu-central-1:111122223333:token-vault/default/oauth2credentialprovider/crm-idp',
          secretArn: 'arn:aws:secretsmanager:eu-central-1:111122223333:secret:provider-AbCdEf',
          scopes: ['crm.read'],
          grant: '3LO',
        },
      },
    });
    return Template.fromStack(stack);
  } finally {
    process.chdir(before);
  }
}

describe('bundling root', () => {
  let scratch: string;
  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-consumer-'));
  });
  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('is this package directory and its lock file', () => {
    expect(bundlingRoot()).toEqual({ projectRoot: PACKAGE_ROOT, depsLockFilePath: path.join(PACKAGE_ROOT, 'package-lock.json') });
    expect(fs.existsSync(bundlingRoot().depsLockFilePath)).toBe(true);
  });

  it('is spread into every NodejsFunction in src, directly or through functionProps', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'smithy') walk(full);
        } else if (entry.name.endsWith('.ts')) {
          files.push(full);
        }
      }
    };
    walk(path.join(PACKAGE_ROOT, 'src'));
    const missing: string[] = [];
    let sites = 0;
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/new NodejsFunction\(/g)) {
        sites += 1;
        const body = text.slice(match.index, match.index + 200);
        if (!body.includes('bundlingRoot()') && !body.includes('functionProps(')) {
          missing.push(`${path.relative(PACKAGE_ROOT, file)}:${text.slice(0, match.index).split('\n').length}`);
        }
      }
    }
    expect(sites).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it('synthesises ToolTarget and SharedIngress from a working directory with no lock file', () => {
    const template = synthFrom(scratch);
    expect(Object.keys(template.findResources('AWS::Lambda::Function')).length).toBeGreaterThan(0);
  });

  it('synthesises them from a working directory with a lock file of its own', () => {
    const app = path.join(scratch, 'app');
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
    const template = synthFrom(app);
    expect(Object.keys(template.findResources('AWS::Lambda::Function')).length).toBeGreaterThan(0);
  });
});
