// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import { awscdk, javascript } from 'projen';

const cdkVersion = '2.274.0';

const project = new awscdk.AwsCdkTypeScriptApp({
  cdkVersion,
  defaultReleaseBranch: 'main',
  github: false,
  name: 'agentic-runtime-isolation',
  description:
    'Agentic runtime isolation for a multi-tenant agent: a backend that trusts one ingress, which maps the validated caller to an isolated compute unit, vends tenant-scoped credentials, limits each tenant, enforces entitlements and mints a transaction token; one ingress fronts one or more registered backends and tools gateways, one Policy engine each; AgentCore Runtime first',
  packageManager: javascript.NodePackageManager.NPM,
  license: 'MIT-0',
  copyrightOwner: 'Amazon.com, Inc. or its affiliates. All Rights Reserved.',
  copyrightPeriod: '',
  projenrcTs: true,
  // Node 24 is the baseline this sample is built and tested on (same as
  // tenant-identity). projen writes it to package.json `engines.node`.
  minNodeVersion: '24.0.0',
  // skipLibCheck: the standalone test tsc otherwise fails inside external
  // .d.ts files we do not control. isolatedModules: ts-jest asks for it with
  // the NodeNext module kind (per-file transpilation is ts-jest's model).
  tsconfigDev: {
    compilerOptions: {
      skipLibCheck: true,
      isolatedModules: true,
    },
  },
  deps: [
    // Runtime: the ingress Lambdas and the echo agent
    '@aws-sdk/client-bedrock-agentcore@3.1154.0', // InvokeAgentRuntime (backend, ADR-0011)
    '@aws-sdk/client-bedrock-runtime@3.1154.0', // agent's ConverseStream call; token usage for the usage event (P-10, ADR-0017)
    '@aws-sdk/client-sts@3.1154.0', // TVM AssumeRole + TagSession (ADR-0012); agent GetCallerIdentity
    '@aws-sdk/client-dynamodb@3.1154.0', // echo agent's demo-table read with vended credentials; v2 entitlement store (C-12)
    '@aws-sdk/lib-dynamodb@3.1154.0', // v2: document client for the entitlement rows (C-12, C-14)
    '@aws-sdk/client-ssm@3.1154.0', // backend registry reads at the ingress, writes from the backend's registry-entry custom resource (ADR-0024)
    '@smithy/node-http-handler@4.12.1', // the agent's shared keep-alive handler across its per-request clients
    // v2: the transaction token and the tool context are signed with KMS only (ADR-0031, ADR-0034, ADR-0037)
    '@aws-sdk/client-kms@3.1154.0',
    // v2: the ToolTarget policy custom resource (Create/Update/Delete/GetPolicy, ADR-0040)
    '@aws-sdk/client-bedrock-agentcore-control@3.1154.0',
    // v2: Smithy SSDK runtime for the entitlement API (generated code in src/smithy imports these;
    // versions are the ones this lock file already resolves for the SDK clients, so no second copy)
    'tslib@2.8.1',
    '@aws-sdk/core@3.978.7',
    '@smithy/core@3.37.0',
    '@smithy/types@4.19.0',
    '@smithy/server-common@0.4.2', // the version smithy-aws-typescript-codegen 0.53.0 generates against
    '@smithy/server-apigateway@0.3.3', // convertEvent / convertVersion1Response, as tenant-identity
    'jose@5.10.0', // JWT VERIFICATION only, against a JWKS (P-3, C-15a); never holds a private key: signing is KMS-only (ADR-0037); 5.x ships CJS, which ts-jest needs (6.x is ESM-only)
    // Security linting - AwsSolutionsChecks aspect applied in src/main.ts
    'cdk-nag@3.0.2',
  ],
  devDeps: [
    '@types/node@24.19.2',
    '@types/aws-lambda@8.10.164',
    'aws-sdk-client-mock@4.1.0',
    'aws-sdk-client-mock-jest@4.1.0',
    'esbuild@0.28.2', // local NodejsFunction bundling and the agent bundle, no Docker needed
  ],
  jestOptions: {
    jestConfig: {
      // ts-jest holds a TypeScript compiler per worker (~1 GB); cap the
      // workers so the build is not OOM-killed on a many-core box.
      maxWorkers: 4,
      workerIdleMemoryLimit: '1GB',
      // e2e suites run against deployed stacks through their own task
      testPathIgnorePatterns: ['/node_modules/', '/test/e2e/'],
      coveragePathIgnorePatterns: ['/node_modules/', '/test/', '/src/smithy/'],
    },
  },
});

// Smithy-generated SSDK output (the entitlement API, C-14) is not linted and
// not committed: `smithy build` regenerates it before every compile.
project.eslint?.addIgnorePattern('src/smithy/**/*');
project.gitignore.exclude('src/smithy/');
project.preCompileTask.exec('smithy build');

// Local working notes and agent config - not part of the sample
project.gitignore.exclude('TODO.md');
project.gitignore.exclude('.kiro/');

// Machine output of the integration test (scripts/integ.sh) and of integ-runner.
project.gitignore.exclude('cdk.integ.out/');
project.gitignore.exclude('test/*.snapshot/');

// Scanner-local state (Holmes MCP project link, ASH reports).
project.gitignore.exclude('.holmes/');
project.gitignore.exclude('.ash/ash_output/');

// ---------------------------------------------------------------------------
// Build-time synth context. src/main.ts fails fast without `ingress` and
// without tenant-identity's SSM parameters resolvable, so `npx projen build`
// supplies labelled placeholders: an ingress (a real choice, as a deploy
// does) and a placeholder user pool and client id that no account can
// resolve (spec §3.3, standard §4.3). A deploy runs its own synth with the
// deployer's --context and reads the real parameters.
// ---------------------------------------------------------------------------
const buildContext = [
  '--context ingress=api-gateway',
  '--context identityParameterPlaceholders=true',
].join(' ');
project.tasks.tryFind('synth:silent')?.reset(`cdk synth -q ${buildContext}`);
project.tasks.tryFind('synth')?.reset(`cdk synth ${buildContext}`);

// ---------------------------------------------------------------------------
// Deployment integration test, v2 (test/integ.runtime.ts, scripts/integ.sh).
// Reuses or deploys tenant-identity (shared-pool, and shared-pool-multi-tenant
// for the user in several tenants), deploys this sample's integration stacks
// (both all-on ingresses, session off, session user, limits, multi-tenant),
// runs spec §8 steps 1 to 24 and prints a step table, and always destroys
// what it deployed. Runs in EXACTLY ONE explicitly selected Region; the
// script fails fast when AWS_REGION is unset.
// ---------------------------------------------------------------------------
const integ = project.addTask('integ', {
  description:
    'Run the deployment integration test in $AWS_REGION (deploys stacks to the current AWS account)',
});
integ.exec('scripts/integ.sh');

// ---------------------------------------------------------------------------
// Exact version pins (supply chain, Holmes CSR finding 2026-10-27). projen
// writes caret ranges for the toolchain it adds itself (eslint, jest,
// typescript, projen, constructs, ...). Pin every dependency that is not
// already exact to the version package-lock.json resolved, so package.json
// and the lock file agree and a fresh install cannot float. `npx projen
// upgrade` refreshes the lock file; the next `npx projen` re-pins.
// ---------------------------------------------------------------------------
if (fs.existsSync('package-lock.json')) {
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8')) as {
    packages?: Record<string, { version?: string }>;
  };
  for (const dep of project.deps.all) {
    const resolved = lock.packages?.[`node_modules/${dep.name}`]?.version;
    const exact = dep.version !== undefined && /^\d+\.\d+\.\d+/.test(dep.version);
    if (!exact && resolved !== undefined && dep.type !== 'peer') {
      project.deps.addDependency(`${dep.name}@${resolved}`, dep.type);
    }
  }
}

project.synth();
