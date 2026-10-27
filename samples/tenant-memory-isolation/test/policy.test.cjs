// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const cedar = require('@cedar-policy/cedar-wasm/nodejs');

const root = path.join(__dirname, '..');
const policies = readdirSync(path.join(root, 'policies'))
  .filter(name => name.endsWith('.cedar'))
  .map(name => readFileSync(path.join(root, 'policies', name), 'utf8')).join('\n');
const gateway = 'arn:aws:bedrock-agentcore:us-west-2:000000000000:gateway/example';
const memory = 'ExampleMemory-1234567890';
const claim = {
  memory_actor: 'tenant-a',
  memory_session: 'shopping-001',
  memory_namespace: '/tenants/tenant-a/shared/',
};
const actions = {
  create: 'POST:/memories/{memoryId}/events',
  list: 'POST:/memories/{memoryId}/actor/{actorId}/sessions/{sessionId}',
  get: 'GET:/memories/{memoryId}/actor/{actorId}/sessions/{sessionId}/events/{eventId}',
  delete: 'DELETE:/memories/{memoryId}/actor/{actorId}/sessions/{sessionId}/events/{eventId}',
  retrieve: 'POST:/memories/{memoryId}/retrieve',
  records: 'POST:/memories/{memoryId}/memoryRecords',
  actors: 'POST:/memories/{memoryId}/actors',
  sessions: 'POST:/memories/{memoryId}/actor/{actorId}/sessions',
  recordId: 'GET:/memories/{memoryId}/memoryRecord/{memoryRecordId}',
  deleteRecord: 'DELETE:/memories/{memoryId}/memoryRecords/{memoryRecordId}',
  extraction: 'POST:/memories/{memoryId}/extractionJobs/start',
};
function decide(operation, input, tags = claim, resource = gateway, type = 'AgentCore::OAuthUser') {
  const principal = { type, id: 'synthetic-agent' };
  const answer = cedar.isAuthorized({
    principal, action: { type: 'AgentCore::Action', id: `tenant-memory___${actions[operation]}` },
    resource: { type: 'AgentCore::Gateway', id: resource },
    context: { input }, policies: { staticPolicies: policies },
    entities: [{ uid: principal, attrs: {}, parents: [], tags }],
  });
  assert.equal(answer.type, 'success', JSON.stringify(answer));
  assert.deepEqual(answer.response.diagnostics.errors, [], JSON.stringify(answer));
  return answer.response.decision;
}
const session = { memoryId: memory, actorId: 'tenant-a', sessionId: 'shopping-001' };
const namespace = { memoryId: memory, namespacePath: claim.memory_namespace };

test('policy text parses in the real Cedar evaluator', () => {
  assert.equal(cedar.checkParsePolicySet({ staticPolicies: policies }).type, 'success');
});
for (const operation of ['create']) {
  test(`${operation}: permits its own actor/session`, () =>
    assert.equal(decide(operation, session), 'allow'));
  test(`${operation}: denies another tenant actor`, () =>
    assert.equal(decide(operation, { ...session, actorId: 'tenant-b' }), 'deny'));
  test(`${operation}: denies another agent session`, () =>
    assert.equal(decide(operation, { ...session, sessionId: 'support-001' }), 'deny'));
}
for (const operation of ['retrieve', 'records']) {
  test(`${operation}: both tenant agents share the same namespace`, () => {
    assert.equal(decide(operation, namespace), 'allow');
    assert.equal(decide(operation, namespace, { ...claim, memory_session: 'support-001' }), 'allow');
  });
  for (const candidate of ['/tenants/', '/tenants/tenant-b/shared/', '/tenants/tenant-a/', '/tenants/tenant-a/shared']) {
    test(`${operation}: denies changed path ${candidate}`, () =>
      assert.equal(decide(operation, { ...namespace, namespacePath: candidate }), 'deny'));
  }
  test(`${operation}: denies namespace alias alongside namespacePath`, () =>
    assert.equal(decide(operation, { ...namespace, namespace: '/tenants/tenant-b/shared/' }), 'deny'));
}
for (const field of Object.keys(claim)) {
  test(`missing ${field} denies its relevant operation`, () => {
    const tags = { ...claim };
    delete tags[field];
    assert.equal(decide(field === 'memory_namespace' ? 'retrieve' : 'create',
      field === 'memory_namespace' ? namespace : session, tags), 'deny');
  });
}
for (const operation of ['list', 'get', 'delete', 'actors', 'sessions', 'recordId', 'deleteRecord', 'extraction']) {
  test(`no tenant permit for ${operation}`, () =>
    assert.equal(decide(operation, { ...session, ...namespace }), 'deny'));
}
test('denies client-supplied extraction namespace overrides', () =>
  assert.equal(decide('create', { ...session, extractionConfig: { namespaceVariables: { tenant: 'tenant-b' } } }), 'deny'));
test('denies another Gateway', () =>
  assert.equal(decide('retrieve', namespace, claim, `${gateway}-other`), 'deny'));
test('IAM principal does not match OAuth permits', () =>
  assert.equal(decide('retrieve', namespace, claim, gateway, 'AgentCore::IamEntity'), 'deny'));
