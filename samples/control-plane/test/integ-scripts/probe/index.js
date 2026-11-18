// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// Integration-test probe. TEST ONLY.
//
// The assertion stack of the integration test is a CloudFormation stack, and
// every assertion adds an output to it: a template holds 200 at most, and the
// scenario of spec section 10 is near that without the hook steps. So the test
// batches the checks that need no waiting between them into one invocation of
// this function: it runs a list of steps in order and returns "ok", or the
// failures of the steps that failed (each named), which the test compares
// against "ok". Three kinds of step:
//   http    one call to the control plane API with a token the test passes
//           (`as` names it), compared by status, error type and a JSON subset
//           of the body. A string beginning `re:` in the subset is a regular
//           expression; an array must have the same length.
//   ssm     existence of named parameters, or a count under paths, in this
//           account (the control plane's)
//   ledger  what the test's hooks recorded together with when every script ran,
//           for spec section 10 step 16 (see below)
//
// The hook ledger: the SSM parameters the test's hooks wrote (one JSON record
// per hook attempt, named by its sequence stamp in epoch nanoseconds) under
// /cp-integ/<fleet>/hooks/{global,app}/, and the builds of the fleet's cell and
// tenant projects with their start time and the environment their script
// received. The provisioning role pair cannot write outside /application-plane/*,
// so a script cannot stamp itself; a script's place in the order is its build's
// start time, and a hook's is the stamp it took while it ran. Hook builds and
// script builds never overlap (R-45), so the two clocks order them.
//
// Ids are replaced by the labels the test passes (T1, cell4, A, ...), so the
// test compares against literals.
const { SSMClient, GetParametersCommand, GetParametersByPathCommand, DeleteParametersCommand } = require('@aws-sdk/client-ssm');
const { CodeBuildClient, ListBuildsForProjectCommand, BatchGetBuildsCommand } = require('@aws-sdk/client-codebuild');

const ssm = new SSMClient({});
const codebuild = new CodeBuildClient({});

exports.handler = async (event) => {
  const ctx = { ...event, labels: new Map(event.labels ?? []), ledger: undefined, builds: new Map() };
  const failures = [];
  for (const step of event.steps) {
    try {
      const problem = await runStep(step, ctx);
      if (problem !== undefined) {
        failures.push(`${step.name}: ${problem}`.slice(0, 2000));
      }
    } catch (error) {
      failures.push(`${step.name}: ${error.message}`.slice(0, 2000));
    }
  }
  if (failures.length === 0) {
    return 'ok';
  }
  // The assertion's output holds about a kilobyte: keep the start of the
  // failures there and the whole of them in this function's log.
  console.log(JSON.stringify(failures));
  return failures.join(' | ').slice(0, 700);
};

/** Runs one step; returns undefined when it passed, else what was wrong. */
async function runStep(step, ctx) {
  if (step.kind === 'http') {
    const res = await fetch(step.url, {
      method: step.method,
      headers: ctx.headers[step.as],
      body: step.body,
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    if (res.status !== step.status) {
      return `status ${res.status}, expected ${step.status}: ${text.slice(0, 300)}`;
    }
    if (step.errorType !== undefined && res.headers.get('x-amzn-errortype') !== step.errorType) {
      return `error type ${res.headers.get('x-amzn-errortype')}, expected ${step.errorType}`;
    }
    if (step.match !== undefined) {
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        return `body is not JSON: ${text.slice(0, 200)}`;
      }
      const mismatch = subsetMismatch(body, step.match, 'body');
      if (mismatch !== undefined) {
        return mismatch;
      }
    }
    return undefined;
  }
  if (step.kind === 'ssm') {
    if (step.names !== undefined) {
      const got = await ssm.send(new GetParametersCommand({ Names: step.names }));
      const found = (got.Parameters ?? []).length;
      const expected = step.exists ? step.names.length : 0;
      return found === expected ? undefined : `${found} of ${step.names.length} parameters exist, expected ${expected}`;
    }
    let count = 0;
    for (const path of step.paths) {
      count += (await listPath(path)).length;
    }
    return count === step.count ? undefined : `${count} parameters under ${step.paths.length} path(s), expected ${step.count}`;
  }
  if (step.kind === 'ledger') {
    const actual = JSON.stringify(sorted(await ledgerCheck(step, ctx)));
    const expected = JSON.stringify(sorted(step.expect));
    return actual === expected ? undefined : `got ${actual}, expected ${expected}`;
  }
  throw new Error(`unknown step kind ${step.kind}`);
}

/** What is wrong where `actual` does not contain `expected`, or undefined. */
function subsetMismatch(actual, expected, where) {
  if (typeof expected === 'string' && expected.startsWith('re:')) {
    return typeof actual === 'string' && new RegExp(expected.slice(3)).test(actual)
      ? undefined : `${where} is ${JSON.stringify(actual)}, expected to match ${expected}`;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      return `${where} is ${JSON.stringify(actual)?.slice(0, 300)}, expected ${expected.length} item(s)`;
    }
    for (let i = 0; i < expected.length; i++) {
      const mismatch = subsetMismatch(actual[i], expected[i], `${where}[${i}]`);
      if (mismatch !== undefined) {
        return mismatch;
      }
    }
    return undefined;
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') {
      return `${where} is ${JSON.stringify(actual)}, expected an object`;
    }
    for (const key of Object.keys(expected)) {
      const mismatch = subsetMismatch(actual[key], expected[key], `${where}.${key}`);
      if (mismatch !== undefined) {
        return mismatch;
      }
    }
    return undefined;
  }
  return actual === expected ? undefined : `${where} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`;
}

/** The value of one ledger check (what the test expects is the step's `expect`). */
async function ledgerCheck(step, ctx) {
  const labels = ctx.labels;
  const label = (id) => (id === undefined || id === '' ? '' : labels.get(id) ?? id);
  const relabel = (text) => [...labels].reduce((acc, [id, name]) => acc.split(id).join(name), text);
  const idOf = (name) => [...labels].find(([, l]) => l === name)?.[0];

  if (step.check === 'cleanup') {
    return { remaining: await cleanup(ctx.fleetName) };
  }
  ctx.ledger ??= await readLedger(ctx.fleetName);
  const records = ctx.ledger.filter((p) => p.record !== undefined);
  const items = records.map((p) => ({ at: Number(BigInt(p.record.stamp) / 1000000n), kind: 'hook', record: p.record }));

  if (step.check === 'strays') {
    return ctx.ledger.filter((p) => p.record === undefined).map((p) => p.name).sort();
  }
  if (step.check === 'cell-deletes') {
    return items
      .filter((i) => i.record.event === 'CELL_DELETE')
      .sort((a, b) => a.at - b.at)
      .map((i) => `hook ${i.record.hookScope}/${i.record.hookId} ${i.record.event} ${i.record.phase} ${label(i.record.cellId)} a${i.record.attempt}`);
  }
  if (step.check === 'story') {
    const cell = idOf(step.cell);
    for (const [level, projectName] of [['cell', ctx.cellProject], ['tenant', ctx.tenantProject]]) {
      for (const b of await readBuilds(projectName)) {
        items.push({ at: b.start, kind: 'script', level, build: b });
      }
    }
    return items
      .filter((i) => (i.kind === 'hook' ? i.record.cellId === cell : i.build.env.CELL_ID === cell))
      .sort((a, b) => a.at - b.at)
      .map((i) => {
        if (i.kind === 'script') {
          const tenant = i.level === 'tenant' ? ` ${label(i.build.env.TENANT_ID)}` : '';
          const status = i.build.status === 'SUCCEEDED' ? '' : ` [${i.build.status}]`;
          return `script ${i.build.env.OPERATION} ${i.level}${tenant}${status}`;
        }
        const r = i.record;
        const tenant = r.tenantId === '' ? '' : ` ${label(r.tenantId)}`;
        return `hook ${r.hookScope}/${r.hookId} ${r.event} ${r.phase}${tenant} a${r.attempt}`;
      });
  }

  const cell = step.cell === undefined ? undefined : idOf(step.cell);
  const tenant = step.tenant === undefined ? undefined : idOf(step.tenant);
  const found = records
    .map((p) => p.record)
    .filter((r) => r.hookId === step.hookId
      && (step.event === undefined || r.event === step.event)
      && (cell === undefined || r.cellId === cell)
      && (tenant === undefined || r.tenantId === tenant))
    .sort((a, b) => (BigInt(a.stamp) < BigInt(b.stamp) ? -1 : 1));

  if (step.check === 'record') {
    const r = found[0];
    if (r === undefined) {
      return 'no such record';
    }
    return {
      ATTEMPT: r.attempt,
      APPLICATION_ID: r.applicationId,
      CELL_ACCOUNT_ID: label(r.cellAccountId),
      CELL_ID: label(r.cellId),
      EVENT: r.event,
      HOOK_ID: r.hookId,
      HOOK_SCOPE: r.hookScope,
      PHASE: r.phase,
      PARAM_HOOK_FAIL: r.hookFail,
      SCRIPT_OUTPUTS: relabel(r.scriptOutputs),
      TENANT_ID: label(r.tenantId),
      callerRole: r.caller.split('/')[1] ?? r.caller,
      denied: r.denied,
      hasExecutionId: r.executionId !== '',
      hasOperatorId: r.operatorId !== '',
      paramNames: r.paramNames,
      scriptOutputsSet: r.scriptOutputsSet,
      tenantNameSet: r.tenantNameSet,
    };
  }
  if (step.check === 'executions') {
    // The hook's records in time order, each with the number of its execution
    // (e1, e2, ... by first appearance), so the test sees which events share an
    // execution without seeing an id.
    const seen = [];
    return found.map((r) => {
      if (!seen.includes(r.executionId)) {
        seen.push(r.executionId);
      }
      return [r.event, label(r.tenantId), `e${seen.indexOf(r.executionId) + 1}`].filter((part) => part !== '').join(' ');
    });
  }
  if (step.check === 'attempts') {
    // The attempts of each execution of the hook, one list per execution.
    const byExecution = new Map();
    for (const r of found) {
      byExecution.set(r.executionId, [...(byExecution.get(r.executionId) ?? []), r.attempt]);
    }
    return [...byExecution.values()];
  }
  throw new Error(`unknown ledger check ${step.check}`);
}

/** Every parameter under a path. */
async function listPath(path) {
  const out = [];
  let token;
  do {
    const page = await ssm.send(new GetParametersByPathCommand({ Path: path, Recursive: true, NextToken: token }));
    out.push(...(page.Parameters ?? []));
    token = page.NextToken;
  } while (token);
  return out;
}

/** Every parameter of the fleet's hook ledger; `record` is absent when its value is not a hook record. */
async function readLedger(fleetName) {
  const out = [];
  for (const scope of ['global', 'app']) {
    for (const p of await listPath(`/cp-integ/${fleetName}/hooks/${scope}`)) {
      let record;
      try {
        const parsed = JSON.parse(p.Value);
        record = typeof parsed.stamp === 'string' && /^\d+$/.test(parsed.stamp) ? parsed : undefined;
      } catch {
        record = undefined;
      }
      out.push({ name: p.Name, record });
    }
  }
  return out;
}

/** Start time, status and script environment of every build of a project. */
async function readBuilds(projectName) {
  const ids = [];
  let token;
  do {
    const page = await codebuild.send(new ListBuildsForProjectCommand({ projectName, sortOrder: 'DESCENDING', nextToken: token }));
    ids.push(...(page.ids ?? []));
    token = page.nextToken;
  } while (token);
  const builds = [];
  for (let i = 0; i < ids.length; i += 100) {
    const got = await codebuild.send(new BatchGetBuildsCommand({ ids: ids.slice(i, i + 100) }));
    for (const b of got.builds ?? []) {
      builds.push({
        start: b.startTime.getTime(),
        status: b.buildStatus,
        env: Object.fromEntries((b.environment?.environmentVariables ?? []).map((v) => [v.name, v.value])),
      });
    }
  }
  return builds;
}

/** Deletes the fleet's whole test path and returns how many parameters are left under it. */
async function cleanup(fleetName) {
  for (let round = 0; round < 20; round++) {
    const names = (await listPath(`/cp-integ/${fleetName}`)).map((p) => p.Name);
    if (names.length === 0) {
      return 0;
    }
    for (let i = 0; i < names.length; i += 10) {
      await ssm.send(new DeleteParametersCommand({ Names: names.slice(i, i + 10) }));
    }
  }
  return -1;
}

/** The value with every object's keys in sorted order, so JSON.stringify of it is stable. */
function sorted(value) {
  if (Array.isArray(value)) {
    return value.map(sorted);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted(value[k])]));
  }
  return value;
}
