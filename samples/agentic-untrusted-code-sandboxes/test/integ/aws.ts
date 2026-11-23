// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The driver's AWS access: the SDK clients of one Region, and the few
 * helpers every step uses (stack outputs, a Lambda invoke, a registry row,
 * the gateway `tools/call`). The ambient credentials of the shell are used;
 * the driver deploys into that account and never prints a credential, token,
 * header value or script output (scripts/CONVENTIONS.md).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { BedrockAgentCoreControlClient } from '@aws-sdk/client-bedrock-agentcore-control';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EC2Client } from '@aws-sdk/client-ec2';
import { ECSClient } from '@aws-sdk/client-ecs';
import { IAMClient } from '@aws-sdk/client-iam';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { LambdaMicrovmsClient } from '@aws-sdk/client-lambda-microvms';
import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient } from '@aws-sdk/client-ssm';
import { STSClient } from '@aws-sdk/client-sts';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { MCP_VERSION, type Backend } from './common';
import { type Credentials } from './sigv4';
import { parseFunctionResponse, parseGatewayResponse, type Outcome } from './tool-result';
import { REGISTRY, registryPk, registrySk } from '../../src/env';

const execFileAsync = promisify(execFile);

export class Aws {
  public readonly cfn: CloudFormationClient;
  public readonly lambda: LambdaClient;
  public readonly ddb: DynamoDBDocumentClient;
  public readonly s3: S3Client;
  public readonly ecs: ECSClient;
  public readonly ec2: EC2Client;
  public readonly iam: IAMClient;
  public readonly logs: CloudWatchLogsClient;
  public readonly microvms: LambdaMicrovmsClient;
  public readonly agentcore: BedrockAgentCoreClient;
  public readonly agentcoreControl: BedrockAgentCoreControlClient;
  public readonly ssm: SSMClient;
  public readonly sts: STSClient;

  public constructor(public readonly region: string) {
    const c = { region };
    this.cfn = new CloudFormationClient(c);
    this.lambda = new LambdaClient(c);
    this.ddb = DynamoDBDocumentClient.from(new DynamoDBClient(c));
    this.s3 = new S3Client(c);
    this.ecs = new ECSClient(c);
    this.ec2 = new EC2Client(c);
    this.iam = new IAMClient(c);
    this.logs = new CloudWatchLogsClient(c);
    this.microvms = new LambdaMicrovmsClient(c);
    this.agentcore = new BedrockAgentCoreClient(c);
    this.agentcoreControl = new BedrockAgentCoreControlClient(c);
    this.ssm = new SSMClient(c);
    this.sts = new STSClient(c);
  }

  /** The ambient credentials, resolved by the SDK; used to sign the presigned URL and never printed. */
  public async credentials(): Promise<Credentials> {
    const provider = this.sts.config.credentials;
    const c = await provider();
    return { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken };
  }

  /** The account id of the ambient credentials (the driver prints it once; the repository never carries it). */
  public async accountId(): Promise<string> {
    const { GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
    const r = await this.sts.send(new GetCallerIdentityCommand({}));
    return r.Account ?? '';
  }

  /** Outputs of one stack, by output key. Empty when the stack does not exist. */
  public async stackOutputs(stackName: string): Promise<Record<string, string>> {
    try {
      const r = await this.cfn.send(new DescribeStacksCommand({ StackName: stackName }));
      const out: Record<string, string> = {};
      for (const o of r.Stacks?.[0]?.Outputs ?? []) if (o.OutputKey && o.OutputValue !== undefined) out[o.OutputKey] = o.OutputValue;
      return out;
    } catch (e) {
      if (e instanceof Error && /does not exist/.test(e.message)) return {};
      throw e;
    }
  }

  /** The stack's status, or undefined when it does not exist. */
  public async stackStatus(stackName: string): Promise<string | undefined> {
    try {
      const r = await this.cfn.send(new DescribeStacksCommand({ StackName: stackName }));
      return r.Stacks?.[0]?.StackStatus;
    } catch (e) {
      if (e instanceof Error && /does not exist/.test(e.message)) return undefined;
      throw e;
    }
  }

  /** Invokes a function with a JSON payload; returns the `FunctionError` and the body. */
  public async invoke(functionName: string, payload: unknown): Promise<{ functionError?: string; body: string }> {
    const r = await this.lambda.send(new InvokeCommand({ FunctionName: functionName, Payload: Buffer.from(JSON.stringify(payload)) }));
    return { functionError: r.FunctionError, body: Buffer.from(r.Payload ?? []).toString('utf8') };
  }

  /** One registry row (spec §4.1), read with the driver's own credentials. */
  public async row(table: string, tenant: string, backend: Backend): Promise<Record<string, unknown> | undefined> {
    const r = await this.ddb.send(new GetCommand({
      TableName: table,
      Key: { [REGISTRY.PK]: registryPk(tenant), [REGISTRY.SK]: registrySk(backend) },
      ConsistentRead: true,
    }));
    return r.Item;
  }

  /**
   * Runs the AWS CLI for the few calls no declared SDK client covers (Service Quotas, Route 53 Resolver). A failure
   * keeps the CLI's own `stderr` (the cause: missing or expired credentials, a not-found answer) on the error, with
   * ARNs and account ids replaced, and names the service and operation in the message. A process that never started
   * has no stderr, and the error's own text stands in for it.
   */
  public async cli(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync('aws', [...args, '--region', this.region, '--output', 'json'], { maxBuffer: 16 * 1024 * 1024 });
      return stdout;
    } catch (e) {
      const raw = (e as { stderr?: unknown }).stderr;
      const cause = typeof raw === 'string' && raw.trim() !== '' ? raw : e instanceof Error ? e.message : String(e);
      const stderr = cause.replace(/arn:aws[\w-]*:[^\s"']+/g, '<arn>').replace(/\b\d{12}\b/g, '<account>').replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '<key>').trim().slice(0, 2000);
      throw Object.assign(new Error(`aws ${args.slice(0, 2).join(' ')} failed: ${stderr}`), { stderr, code: (e as { code?: unknown }).code });
    }
  }
}

/** One gateway `tools/call`, with a bearer token the caller minted. The token and the answer's text are never logged. */
export async function callGateway(
  gatewayUrl: string, token: string, toolName: string, args: Record<string, unknown>, timeoutMs = 130_000,
): Promise<{ status: number; outcome: Outcome; ms: number }> {
  const t0 = Date.now();
  const res = await fetch(gatewayUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'MCP-Protocol-Version': MCP_VERSION,
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: args } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  return { status: res.status, outcome: parseGatewayResponse(res.status, text), ms: Date.now() - t0 };
}

/** A direct invoke of `runCodeFunction` (the standalone entry) with the ambient or an assumed role's credentials. */
export async function callStandalone(
  client: LambdaClient, functionName: string, args: Record<string, unknown>,
): Promise<{ outcome: Outcome; ms: number }> {
  const t0 = Date.now();
  try {
    const r = await client.send(new InvokeCommand({ FunctionName: functionName, Payload: Buffer.from(JSON.stringify(args)) }));
    return { outcome: parseFunctionResponse(r.FunctionError, Buffer.from(r.Payload ?? []).toString('utf8')), ms: Date.now() - t0 };
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    if (/AccessDenied|NotAuthorized/.test(name) || (e instanceof Error && /not authorized|AccessDenied/i.test(e.message))) {
      return { outcome: { kind: 'refused', status: 403 }, ms: Date.now() - t0 };
    }
    throw e;
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `fn` until it returns a value that is not undefined, or the deadline passes. */
export async function until<T>(fn: () => Promise<T | undefined>, deadlineMs: number, everyMs = 5000): Promise<T | undefined> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() + everyMs > end) return undefined;
    await sleep(everyMs);
  }
}
