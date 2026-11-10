// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Deployment integration test steps (standard §5.2, ADR-0010), run by
 * scripts/integ.sh against the deployed demo stack. It is the reference
 * implementation of the sample's wiring: it reads only the published
 * parameter, signs in through the published issuer, and calls Memory only
 * through the published Gateway, except in step 8, which calls Memory
 * directly to prove the fence. Steps are named as the README's table.
 *
 * Synthetic data only. Tokens, passwords, and Memory content stay in
 * process memory; the report holds step names, statuses, and HTTP codes.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  BatchCreateMemoryRecordsCommand,
  BedrockAgentCoreClient,
  IngestDataCommand,
  RetrieveMemoryRecordsCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  BedrockAgentCoreControlClient,
  CreatePolicyCommand,
  DeletePolicyCommand,
  GetGatewayCommand,
  GetGatewayTargetCommand,
  GetPolicyCommand,
  GetResourcePolicyCommand,
  ListGatewayTargetsCommand,
  PutResourcePolicyCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminInitiateAuthCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  DeleteRolePolicyCommand,
  GetRoleCommand,
  IAMClient,
  ListAttachedRolePoliciesCommand,
  PutRolePolicyCommand,
  SimulatePrincipalPolicyCommand,
} from '@aws-sdk/client-iam';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { claimsOf, MemoryGateway } from './integ/gateway-client';
import type { PublishedMemoryGateway } from '../src/demo.cdk';
import { PUBLISHED_PARAMETER } from '../src/demo.cdk';
import { MEMORY_DATA_ACTIONS } from '../src/fence';
import { ACTION_IDS, TARGET_NAME } from '../src/policies';

const region = process.env.AWS_REGION;
if (!region) {
  throw new Error('Set AWS_REGION to the one Region under test');
}
const RUN = randomBytes(4).toString('hex');
const EXTRACTION_TIMEOUT_MS = 15 * 60_000;

const ssm = new SSMClient({ region });
const control = new BedrockAgentCoreControlClient({ region });
const direct = new BedrockAgentCoreClient({ region });
const cognito = new CognitoIdentityProviderClient({ region });
const iam = new IAMClient({ region });
const sts = new STSClient({ region });
const cwl = new CloudWatchLogsClient({ region });

// --- Identities: two users of tenant-a, one of tenant-ab (an id that extends tenant-a's) ---
const USERS = {
  'a-shopping': 'tenant-a',
  'a-support': 'tenant-a',
  'b-shopping': 'tenant-ab',
} as const;
type User = keyof typeof USERS;

interface Session {
  readonly password: string;
  access: string;
  id: string;
  issuedAt: number;
  sub: string;
}

interface StepResult {
  readonly step: string;
  readonly result: 'PASS' | 'FAIL';
  readonly detail?: string;
}

const results: StepResult[] = [];
const findings: Record<string, string> = {};
const sessions = new Map<User, Session>();
const cleanups: Array<{ name: string; run: () => Promise<void> }> = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function step(name: string, body: () => Promise<string | void>): Promise<void> {
  const started = Date.now();
  try {
    const detail = (await body()) ?? undefined;
    results.push({ step: name, result: 'PASS', detail: detail ?? undefined });
    console.log(`PASS ${name}${detail ? ` (${detail})` : ''} [${Math.round((Date.now() - started) / 1000)}s]`);
  } catch (error) {
    results.push({ step: name, result: 'FAIL', detail: (error as Error).message });
    console.log(`FAIL ${name}: ${(error as Error).message}`);
    throw error;
  }
}

async function main(): Promise<void> {
  const parameter = await ssm.send(new GetParameterCommand({ Name: PUBLISHED_PARAMETER }));
  const published = JSON.parse(parameter.Parameter!.Value!) as PublishedMemoryGateway;
  check(published.demoIssuer !== undefined, 'the integration test needs the bundled demo issuer');
  const { userPoolId, appClientId } = published.demoIssuer!;
  const gatewayId = published.gatewayArn.split('/').pop()!;
  const gateway = new MemoryGateway(published.gatewayUrl, published.targetName, published.memoryId);
  const tenantOf = (user: User) => USERS[user];

  async function token(user: User, kind: 'access' | 'id' = 'access'): Promise<string> {
    const session = sessions.get(user)!;
    if (Date.now() - session.issuedAt > 4 * 60_000) {
      const auth = await cognito.send(
        new AdminInitiateAuthCommand({
          UserPoolId: userPoolId,
          ClientId: appClientId,
          AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
          AuthParameters: { USERNAME: `${user}-${RUN}`, PASSWORD: session.password },
        }),
      );
      session.access = auth.AuthenticationResult!.AccessToken!;
      session.id = auth.AuthenticationResult!.IdToken!;
      session.issuedAt = Date.now();
    }
    return kind === 'access' ? session.access : session.id;
  }

  // ---------------------------------------------------------------------
  await step('1. Preflight: published Gateway, connector, role, fence', async () => {
    const gw = await control.send(new GetGatewayCommand({ gatewayIdentifier: gatewayId }));
    check(gw.authorizerType === 'CUSTOM_JWT', 'Gateway must use CUSTOM_JWT');
    check(gw.protocolType === undefined, 'Gateway must have no MCP protocol type (ADR-0006)');
    check(gw.exceptionLevel === undefined, 'Gateway must return generic errors');
    check(gw.policyEngineConfiguration?.mode === 'ENFORCE', 'Policy must be ENFORCE');
    check(gw.roleArn === published.gatewayRoleArn, 'Gateway role differs from the published one');
    const targets = await control.send(new ListGatewayTargetsCommand({ gatewayIdentifier: gatewayId }));
    check(targets.items?.length === 1, 'exactly one target expected');
    const target = await control.send(new GetGatewayTargetCommand({ gatewayIdentifier: gatewayId, targetId: targets.items![0].targetId! }));
    const connector = target.targetConfiguration?.http?.connector;
    check(target.name === TARGET_NAME && connector?.source?.connectorId === 'agentcore-memory', 'target must be the native Memory connector');
    check(connector?.parameters?.memoryId === published.memoryId, 'connector must front the published Memory');
    // ADR-0011: the role trusts this Gateway's name pattern, which the deployed ARN must match.
    const role = await iam.send(new GetRoleCommand({ RoleName: published.gatewayRoleArn.split('/').pop()! }));
    type Trust = { Statement: Array<{ Condition: Record<string, Record<string, string | string[]>> }> };
    const trust = JSON.parse(decodeURIComponent(role.Role!.AssumeRolePolicyDocument!)) as Trust;
    const patterns = [trust.Statement[0].Condition.ArnLike['aws:SourceArn']].flat();
    const matches = patterns.some((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '.').replace(/\*/g, '.*')}$`).test(published.gatewayArn));
    check(matches, 'the role trust pattern does not match the deployed Gateway ARN');
    check(!patterns.some((p) => p.endsWith('gateway/*')), 'the role trust must not cover every Gateway');
    const attached = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: role.Role!.RoleName! }));
    check((attached.AttachedPolicies ?? []).length === 0, 'the Gateway role must have no managed policies');
    // Re-test (d): the deployed fence was accepted with IngestData and every other data operation.
    const fence = await control.send(new GetResourcePolicyCommand({ resourceArn: published.memoryArn }));
    for (const name of MEMORY_DATA_ACTIONS) {
      check(fence.policy!.includes(`bedrock-agentcore:${name}`), `the deployed fence lacks ${name}`);
    }
    findings['IngestData in the fence'] = 'accepted by PutResourcePolicy (deployed and read back)';
    return 'CUSTOM_JWT, ENFORCE, no MCP, generic errors; role pinned; fence has all 16 data operations';
  });

  // ---------------------------------------------------------------------
  await step('2. Issue tokens: the repository claim set, nothing else', async () => {
    for (const [user, tenant] of Object.entries(USERS) as Array<[User, string]>) {
      const username = `${user}-${RUN}`;
      const password = `${randomBytes(18).toString('base64url')}Aa1!`;
      await cognito.send(
        new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: username,
          MessageAction: 'SUPPRESS',
          UserAttributes: [{ Name: 'custom:tenantId', Value: tenant }],
        }),
      );
      cleanups.push({ name: `delete user ${user}`, run: async () => void (await cognito.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username }))) });
      await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: username, Password: password, Permanent: true }));
      sessions.set(user, { password, access: '', id: '', issuedAt: 0, sub: '' });
      const access = await token(user);
      const claims = claimsOf(access);
      check(claims.tenant_id === tenant, `${user}: tenant_id`);
      check(claims.token_use === 'access' && claims.client_id === appClientId && typeof claims.sub === 'string', `${user}: token_use, client_id, sub`);
      check(!Object.keys(claims).some((k) => k.startsWith('memory_')), `${user}: no custom memory claims`);
      sessions.get(user)!.sub = claims.sub as string;
    }
    return 'tenant_id, sub, client_id, token_use=access';
  });
  const sub = (user: User) => sessions.get(user)!.sub;
  const firstAccess = { token: sessions.get('a-shopping')!.access, exp: claimsOf(sessions.get('a-shopping')!.access).exp as number };

  // ---------------------------------------------------------------------
  const markers = { 'tenant-a': `Amber${RUN}`, 'tenant-ab': `Blue${RUN}` };
  await step('3. Scoped writes: each user writes its own tenant and session', async () => {
    for (const user of ['a-shopping', 'b-shopping'] as const) {
      const marker = markers[tenantOf(user)];
      let status = 0;
      for (let attempt = 0; attempt < 12; attempt++) {
        ({ status } = await gateway.createEvent(await token(user), tenantOf(user), sub(user), `Our organisation's warehouse codename is ${marker}. Remember this shared operational fact.`, { clientToken: `${user}-${RUN}-fact` }));
        if (status < 300) {
          break;
        }
        await sleep(10_000); // newly ACTIVE policies and IAM grants settle within seconds
      }
      check(status >= 200 && status < 300, `${user} write returned ${status}`);
    }
    const support = await gateway.createEvent(await token('a-support'), 'tenant-a', sub('a-support'), 'Synthetic support conversation.');
    check(support.status < 300, `a-support write returned ${support.status}`);
    return 'three writes allowed';
  });

  // ---------------------------------------------------------------------
  await step('4. Write denials: other tenant, other session, extraction override, ID token', async () => {
    const a = await token('a-shopping');
    const cases: Array<[string, Promise<{ status: number }>, number[]]> = [
      ['A writes under tenant-ab', gateway.createEvent(a, 'tenant-ab', sub('a-shopping'), 'Synthetic rejected write'), [403]],
      ['A shopping writes into A support session', gateway.createEvent(a, 'tenant-a', sub('a-support'), 'Synthetic rejected write'), [403]],
      ['A overrides extraction', gateway.createEvent(a, 'tenant-a', sub('a-shopping'), 'Synthetic rejected write', { extractionConfig: { namespaceVariables: { x: 'tenant-ab' } } }), [403]],
      ['A presents its ID token', gateway.createEvent(await token('a-shopping', 'id'), 'tenant-a', sub('a-shopping'), 'Synthetic rejected write'), [401, 403]],
    ];
    const seen: string[] = [];
    for (const [name, call, expected] of cases) {
      const { status } = await call;
      check(expected.includes(status), `${name}: expected ${expected.join('/')}, got ${status}`);
      seen.push(`${name}=${status}`);
    }
    findings['ID token at the Gateway'] = seen[3];
    return seen.join('; ');
  });

  // ---------------------------------------------------------------------
  await step('5. Recall and enumeration denials', async () => {
    const a = await token('a-shopping');
    const b = await token('b-shopping');
    const cases: Array<[string, Promise<{ status: number }>]> = [
      ['A retrieves tenant-ab', gateway.retrieve(a, { namespace: 'tenant-ab' })],
      ['B retrieves tenant-a', gateway.retrieve(b, { namespace: 'tenant-a' })],
      ['A retrieves its own path hierarchically', gateway.retrieve(a, { namespacePath: 'tenant-a' })],
      ['A retrieves the root hierarchy', gateway.retrieve(a, { namespacePath: '/' })],
      ['A retrieves namespace *', gateway.retrieve(a, { namespace: '*' })],
      ['A lists tenant-ab records', gateway.listRecords(a, { namespace: 'tenant-ab' })],
      ['A enumerates actors', gateway.listActors(a)],
      ['A reads its own events (no permit, ADR-0005)', gateway.listEvents(a, 'tenant-a', sub('a-shopping'))],
    ];
    for (const [name, call] of cases) {
      const { status } = await call;
      check(status === 403, `${name}: expected 403, got ${status}`);
    }
    return `${cases.length} requests denied with 403`;
  });

  // ---------------------------------------------------------------------
  let recordId = '';
  await step('6. Shared recall: both tenant-a users see tenant-a facts; tenant-ab sees only its own', async () => {
    const deadline = Date.now() + EXTRACTION_TIMEOUT_MS;
    for (;;) {
      const seen: Record<string, string> = {};
      for (const user of Object.keys(USERS) as User[]) {
        const response = await gateway.retrieve(await token(user), { namespace: tenantOf(user) });
        check(response.status === 200, `${user} own recall returned ${response.status}`);
        seen[user] = JSON.stringify(response.body);
      }
      if (seen['a-shopping'].includes(markers['tenant-ab']) || seen['a-support'].includes(markers['tenant-ab']) || seen['b-shopping'].includes(markers['tenant-a'])) {
        throw new Error('a canary of the other tenant appeared in an allowed response');
      }
      if (seen['a-shopping'].includes(markers['tenant-a']) && seen['a-support'].includes(markers['tenant-a']) && seen['b-shopping'].includes(markers['tenant-ab'])) {
        break;
      }
      check(Date.now() < deadline, 'extraction not observed within 15 minutes: the run is incomplete, not an isolation result');
      await sleep(15_000);
    }
    const listed = await gateway.listRecords(await token('a-shopping'), { namespace: 'tenant-a' });
    check(listed.status === 200, `own list returned ${listed.status}`);
    const summaries = (listed.body as { memoryRecordSummaries?: Array<{ memoryRecordId: string }> }).memoryRecordSummaries ?? [];
    check(summaries.length > 0, 'own list returned no records');
    recordId = summaries[0].memoryRecordId;
    return 'canaries shared within tenant-a, isolated from tenant-ab';
  });

  // ---------------------------------------------------------------------
  await step('7. Record-ID access has no permit', async () => {
    const { status } = await gateway.getRecord(await token('a-shopping'), recordId);
    check(status === 403, `GetMemoryRecord returned ${status}`);
  });

  // ---------------------------------------------------------------------
  await step('8. Outside the Gateway: direct calls and role assumption are denied', async () => {
    const caller = (await sts.send(new GetCallerIdentityCommand({}))).Arn!;
    const source = caller.includes(':assumed-role/')
      ? (await iam.send(new GetRoleCommand({ RoleName: caller.split('/')[1] }))).Role!.Arn!
      : caller;
    const allows = async (action: string, resource: string) => {
      const result = await iam.send(new SimulatePrincipalPolicyCommand({ PolicySourceArn: source, ActionNames: [action], ResourceArns: [resource] }));
      return result.EvaluationResults?.every((r) => r.EvalDecision === 'allowed') ?? false;
    };
    const denied = async (name: string, action: string, resource: string, call: () => Promise<unknown>) => {
      // The probe proves the fence or the trust only if the caller's own policies would allow it.
      check(await allows(action, resource), `${name}: the operator's identity does not allow ${action}, so a denial would prove nothing`);
      try {
        await call();
      } catch (error) {
        const code = (error as { name?: string }).name ?? '';
        check(code === 'AccessDeniedException' || code === 'AccessDenied', `${name}: unexpected ${code}`);
        return;
      }
      throw new Error(`${name}: the call was allowed`);
    };
    const now = new Date();
    await denied('direct retrieve', 'bedrock-agentcore:RetrieveMemoryRecords', published.memoryArn, () =>
      direct.send(new RetrieveMemoryRecordsCommand({ memoryId: published.memoryId, namespace: 'tenant-a', searchCriteria: { searchQuery: 'warehouse codename' } })),
    );
    await denied('direct ingest', 'bedrock-agentcore:IngestData', published.memoryArn, () =>
      direct.send(new IngestDataCommand({ memoryId: published.memoryId, actorId: 'tenant-a', contentTimestamp: now, source: { inline: { payload: [{ conversational: { role: 'USER', content: { text: 'Synthetic rejected ingestion' } } }] } } })),
    );
    await denied('direct batch create', 'bedrock-agentcore:BatchCreateMemoryRecords', published.memoryArn, () =>
      direct.send(new BatchCreateMemoryRecordsCommand({ memoryId: published.memoryId, records: [{ requestIdentifier: 'r1', namespaces: ['tenant-a'], content: { text: 'Synthetic rejected record' }, timestamp: now }] })),
    );
    await denied('assume the Gateway role', 'sts:AssumeRole', published.gatewayRoleArn, () =>
      sts.send(new AssumeRoleCommand({ RoleArn: published.gatewayRoleArn, RoleSessionName: 'outside-gateway-probe' })),
    );
    return 'retrieve, ingest, batch create, AssumeRole denied; each would otherwise be allowed';
  });

  // ---------------------------------------------------------------------
  await step('9. Re-test (a): does the Gateway stamp aws:SourceArn on its Memory calls?', async () => {
    const original = (await control.send(new GetResourcePolicyCommand({ resourceArn: published.memoryArn }))).policy!;
    const probe = JSON.parse(original) as { Statement: object[] };
    probe.Statement.push({
      Sid: 'IntegRetestSourceArn',
      Effect: 'Deny',
      Principal: '*',
      Action: 'bedrock-agentcore:RetrieveMemoryRecords',
      Resource: published.memoryArn,
      Condition: { ArnNotEquals: { 'aws:SourceArn': published.gatewayArn } },
    });
    const restore = async () => void (await control.send(new PutResourcePolicyCommand({ resourceArn: published.memoryArn, policy: original })));
    cleanups.push({ name: 'restore the fence', run: restore });
    await control.send(new PutResourcePolicyCommand({ resourceArn: published.memoryArn, policy: JSON.stringify(probe) }));
    await sleep(30_000);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await gateway.retrieve(await token('a-shopping'), { namespace: 'tenant-a' })).status);
      await sleep(5_000);
    }
    await restore();
    cleanups.pop();
    const present = statuses.every((s) => s === 200);
    findings['aws:SourceArn on Gateway-forwarded calls'] = present ? `present (retrieve ${statuses.join(',')} under a SourceArn-conditioned Deny)` : `absent or not matching (retrieve ${statuses.join(',')})`;
    // Back to the deployed fence: own recall must succeed again.
    for (let i = 0; ; i++) {
      if ((await gateway.retrieve(await token('a-shopping'), { namespace: 'tenant-a' })).status === 200) {
        break;
      }
      check(i < 12, 'own recall did not recover after restoring the fence');
      await sleep(10_000);
    }
    return findings['aws:SourceArn on Gateway-forwarded calls'];
  });

  // ---------------------------------------------------------------------
  await step('10. Re-test (b): does Policy see ListEvents path parameters?', async () => {
    const engineId = published.policyEngineArn.split('/').pop()!;
    const roleName = published.gatewayRoleArn.split('/').pop()!;
    await iam.send(
      new PutRolePolicyCommand({
        RoleName: roleName,
        PolicyName: 'IntegRetestListEvents',
        PolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'bedrock-agentcore:ListEvents', Resource: published.memoryArn }] }),
      }),
    );
    cleanups.push({ name: 'remove the re-test role policy', run: async () => void (await iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: 'IntegRetestListEvents' }))) });
    const statement = [
      'permit (',
      '    principal is AgentCore::OAuthUser,',
      `    action == AgentCore::Action::"${TARGET_NAME}___${ACTION_IDS.ListEvents}",`,
      `    resource == AgentCore::Gateway::"${published.gatewayArn}"`,
      ') when {',
      '    principal.hasTag("tenant_id") && principal.hasTag("sub") &&',
      '    context has input && context.input has actorId && context.input has sessionId &&',
      '    context.input.actorId == principal.getTag("tenant_id") &&',
      '    context.input.sessionId == principal.getTag("sub")',
      '};',
    ].join('\n');
    const created = await control.send(
      new CreatePolicyCommand({
        policyEngineId: engineId,
        name: `integ_listevents_${RUN}`,
        definition: { cedar: { statement } },
        validationMode: 'FAIL_ON_ANY_FINDINGS',
      }),
    );
    const policyId = created.policyId!;
    const removePolicy = async () => {
      await control.send(new DeletePolicyCommand({ policyEngineId: engineId, policyId }));
      for (let i = 0; i < 60; i++) {
        try {
          await control.send(new GetPolicyCommand({ policyEngineId: engineId, policyId }));
        } catch {
          return;
        }
        await sleep(5_000);
      }
      throw new Error('the re-test policy was not deleted');
    };
    cleanups.push({ name: 'delete the re-test Cedar policy', run: removePolicy });
    for (let i = 0; ; i++) {
      const policy = await control.send(new GetPolicyCommand({ policyEngineId: engineId, policyId }));
      if (policy.status === 'ACTIVE') {
        break;
      }
      check(!String(policy.status).includes('FAILED') && i < 60, `re-test policy ${policy.status}`);
      await sleep(5_000);
    }
    await sleep(15_000);
    let own = 0;
    for (let i = 0; i < 6; i++) {
      own = (await gateway.listEvents(await token('a-shopping'), 'tenant-a', sub('a-shopping'))).status;
      if (own === 200) {
        break;
      }
      await sleep(10_000);
    }
    const other = (await gateway.listEvents(await token('a-shopping'), 'tenant-a', sub('a-support'))).status;
    findings['ListEvents path parameters in Policy context'] = own === 200 ? `present (own session ${own}, other session ${other})` : `absent (own session ${own}, other session ${other})`;
    check(other === 403, `with the re-test permit, another session's events must still be denied (got ${other})`);
    // Undo in reverse order now rather than at the end.
    await removePolicy();
    cleanups.pop();
    await iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: 'IntegRetestListEvents' }));
    cleanups.pop();
    return findings['ListEvents path parameters in Policy context'];
  });

  // ---------------------------------------------------------------------
  await step('11. Re-test (c): a path memoryId other than the target\'s is refused', async () => {
    const { status } = await gateway.retrieve(await token('a-shopping'), { namespace: 'tenant-a' }, 'warehouse codename', 'OtherMemory-abcdefghij');
    findings['memoryId mismatch'] = `HTTP ${status}`;
    check(status >= 400, `a foreign memoryId returned ${status}`);
    return `HTTP ${status}`;
  });

  // ---------------------------------------------------------------------
  await step('12. An expired token fails authentication (401) on a request its scope permits', async () => {
    const wait = firstAccess.exp * 1000 + 10_000 - Date.now();
    if (wait > 0) {
      await sleep(wait);
    }
    const { status } = await gateway.retrieve(firstAccess.token, { namespace: 'tenant-a' });
    check(status === 401, `expired token returned ${status}`);
  });

  // ---------------------------------------------------------------------
  await step('13. Per-tenant telemetry: Memory logs name the tenant, never the content', async () => {
    const deadline = Date.now() + 10 * 60_000;
    let tenants = new Set<string>();
    for (;;) {
      const events = await cwl.send(new FilterLogEventsCommand({ logGroupName: published.applicationLogGroup, startTime: Date.now() - 60 * 60_000 }));
      tenants = new Set<string>();
      for (const event of events.events ?? []) {
        try {
          const line = JSON.parse(event.message ?? '{}') as Record<string, unknown>;
          for (const key of ['actor_id', 'namespace']) {
            if (typeof line[key] === 'string') {
              tenants.add(line[key] as string);
            }
          }
        } catch {
          // non-JSON lines carry no tenant field
        }
      }
      if (tenants.has('tenant-a') && tenants.has('tenant-ab')) {
        break;
      }
      check(Date.now() < deadline, `application logs named only ${[...tenants].join(', ') || 'no tenant'} within 10 minutes`);
      await sleep(30_000);
    }
    for (const marker of Object.values(markers)) {
      const hits = await cwl.send(new FilterLogEventsCommand({ logGroupName: published.applicationLogGroup, filterPattern: `"${marker}"` }));
      check((hits.events ?? []).length === 0, 'a canary fact appeared in the application logs');
    }
    findings['Memory application log tenant fields'] = 'actor_id / namespace carry tenant-a and tenant-ab; no fact content';
    return findings['Memory application log tenant fields'];
  });
}

async function cleanup(): Promise<void> {
  for (const item of cleanups.reverse()) {
    try {
      await item.run();
      console.log(`CLEANUP ${item.name}`);
    } catch (error) {
      results.push({ step: `cleanup: ${item.name}`, result: 'FAIL', detail: (error as Error).name });
      console.log(`CLEANUP FAILED ${item.name}: ${(error as Error).name}`);
    }
  }
}

main()
  .catch((error: Error) => {
    // A failed step has already printed itself; anything else failed before step 1.
    if (!results.some((r) => r.result === 'FAIL')) {
      results.push({ step: 'setup', result: 'FAIL', detail: error.name });
      console.log(`FAIL setup: ${error.name}`);
    }
  })
  .finally(async () => {
    await cleanup();
    const failed = results.some((r) => r.result === 'FAIL') || results.length < 13;
    const report = { status: failed ? 'FAILED' : 'PASSED', date: new Date().toISOString(), region, run: RUN, id: randomUUID(), steps: results, findings };
    writeFileSync('integ-report.json', `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${results.filter((r) => r.result === 'PASS').length} steps passed; findings:`);
    for (const [key, value] of Object.entries(findings)) {
      console.log(`  ${key}: ${value}`);
    }
    process.exitCode = failed ? 1 : 0;
  });
