// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import { awscdk, javascript } from 'projen';

const cdkVersion = '2.274.0';

const project = new awscdk.AwsCdkTypeScriptApp({
  cdkVersion,
  defaultReleaseBranch: 'main',
  github: false,
  name: 'tenant-encrypted-ingestion',
  description:
    'Per-tenant encrypted ingestion for agentic applications: one KMS key per tenant bound to its S3 prefix by key policy, identity-policy ABAC tenant roles, write-once presigned uploads, validate-then-land with a pluggable validator chain',
  packageManager: javascript.NodePackageManager.NPM,
  license: 'MIT-0',
  copyrightOwner: 'Amazon.com, Inc. or its affiliates. All Rights Reserved.',
  copyrightPeriod: '',
  projenrcTs: true,
  // The README is phase 7 of the sample (standard §7); until then a stub
  // points at the design trail. projen writes it only when it is missing.
  readme: {
    filename: 'README.md',
    contents: [
      '<!--',
      'Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.',
      'SPDX-License-Identifier: MIT-0',
      '-->',
      '# Tenant Encrypted Ingestion',
      '',
      'README pending (phase 7). The specification is design/tenant-encrypted-ingestion.spec.md;',
      'the decisions are in adr/ and the threats and mitigations in threat-model.md.',
      '',
    ].join('\n'),
  },
  // Node 24 is the baseline this sample is built and tested on (same as
  // tenant-identity and agentic-runtime-isolation).
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
    // Smithy SSDK runtime (generated code in src/smithy imports these; the
    // versions the SDK clients resolve, so each is installed once; the
    // generated SSDK accepts them (its package.json asks for ^ ranges)
    'tslib@2.8.1',
    '@aws-sdk/core@3.980.0', // the version the SDK clients resolve, so one copy is installed
    '@smithy/core@3.39.0',
    '@smithy/fetch-http-handler@5.8.0',
    '@smithy/node-http-handler@4.14.2',
    '@smithy/server-common@0.4.2',
    '@smithy/server-apigateway@0.3.3',
    '@smithy/types@4.20.0',
    // Runtime: the API, platform, processor, sweep and watch functions
    '@aws-sdk/client-s3@3.1154.0', // presigned PUT, HeadObject, pinned GetObject, CopyObject, probe (spec §7.5, §8)
    '@aws-sdk/s3-request-presigner@3.1154.0', // signableHeaders / unhoistableHeaders (spec §7.5, M-6)
    '@aws-sdk/client-kms@3.1154.0', // CreateKey with the §7.2 policy, DescribeKey, rotation, deletion (ADR-0001, ADR-0005)
    '@aws-sdk/client-sts@3.1154.0', // AssumeRole + TagSession into the tenant roles (ADR-0003)
    '@aws-sdk/client-dynamodb@3.1154.0', // the registry (spec §4)
    '@aws-sdk/lib-dynamodb@3.1154.0', // document marshalling for the registry
    '@aws-sdk/client-eventbridge@3.1154.0', // Delivery* events (spec §5.4)
    '@aws-sdk/client-sqs@3.1154.0', // registry watch on-failure queue types; integ DLQ checks
    '@aws-sdk/client-api-gateway@3.1154.0', // per-tenant API keys with tenantThrottle (N-8, ADR-0011)
    '@aws-sdk/client-lambda@3.1154.0', // validator invocation (spec §3.5, ADR-0008)
    '@aws-sdk/client-ssm@3.1154.0', // the test-switch validator's mode parameter; integ parameter reads
    '@aws-sdk/client-cloudwatch@3.1154.0', // registry watch alarm metric (M-24)
    // The scope-registration custom resource signs PUT/DELETE /platform/scopes/* on tenant-identity's API (copied from agentic-runtime-isolation)
    '@aws-sdk/credential-providers@3.1154.0',
    '@aws-crypto/sha256-js@5.2.0',
    '@smithy/signature-v4@5.7.5',
    '@smithy/protocol-http@5.6.2',
    'jose@5.10.0', // JWT verification against the issuer's JWKS (M-1); 5.x ships CJS, which ts-jest needs
    'ulid@3.0.2', // delivery ids and probe object names (spec §4.2, §8)
    // Security linting - AwsSolutionsChecks aspect applied in src/main.ts
    'cdk-nag@3.0.2',
  ],
  devDeps: [
    '@types/node@24.19.2',
    '@types/aws-lambda@8.10.164',
    'aws-sdk-client-mock@4.1.0',
    'aws-sdk-client-mock-jest@4.1.0',
    'esbuild@0.28.2', // local NodejsFunction bundling, no Docker needed
    '@aws-sdk/client-iam@3.1154.0', // integ step 5: SimulatePrincipalPolicy on the deployed tenant roles
    '@aws-sdk/client-cloudformation@3.1154.0', // integ: stack status checks
    '@aws-sdk/client-cloudwatch-logs@3.1154.0', // integ steps 7b, 10: FilterLogEvents over the stack's log groups
    '@aws-sdk/client-cloudtrail@3.1154.0', // integ step 10: kmsRequests against CloudTrail for one delivery
  ],
  jestOptions: {
    jestConfig: {
      // ts-jest holds a TypeScript compiler per worker (~1 GB); cap the
      // workers so the build is not OOM-killed on a many-core box.
      maxWorkers: 4,
      workerIdleMemoryLimit: '1GB',
      // the integration test runs against deployed stacks through scripts/integ.sh
      testPathIgnorePatterns: ['/node_modules/', '/test/integ/', 'integ\\.ingestion\\.ts$'],
      coveragePathIgnorePatterns: ['/node_modules/', '/test/', '/src/smithy/'],
    },
  },
});

// The example validator is type-checked and linted with the tests (the
// production compile's rootDir is src/; the demo stack bundles the example
// with esbuild).
project.tsconfigDev.addInclude('../examples/**/*.ts');

// Smithy-generated SSDK output is not linted (regenerated by `smithy build`)
project.eslint?.addIgnorePattern('src/smithy/**/*');
project.eslint?.addLintPattern('examples');

// Generated output is not committed - `smithy build` recreates it before compile
project.gitignore.exclude('src/smithy/');

// Local working notes and agent config - not part of the sample
project.gitignore.exclude('TODO.md');
project.gitignore.exclude('.kiro/');

// Machine output of the integration test (scripts/integ.sh).
project.gitignore.exclude('cdk.integ.out/');
project.gitignore.exclude('test/*.snapshot/');

// Scanner-local state (Holmes MCP project link, ASH reports).
project.gitignore.exclude('.holmes/');
project.gitignore.exclude('.ash/ash_output/');

// Regenerate the SSDKs + OpenAPI documents from the model before every compile
project.preCompileTask.exec('smithy build');

// ts-jest transpiles per file (isolatedModules) and reports no type errors,
// so the tests, the integration steps and the example are type-checked here.
project.testTask.prependExec('tsc --noEmit -p test/tsconfig.json');

// ---------------------------------------------------------------------------
// Build-time synth context. src/main.ts fails fast without tenant-identity's
// SSM parameters resolvable, so `npx projen build` supplies labelled
// placeholders that no account can resolve and that a CloudFormation rule
// refuses to deploy (spec §3.3, standard §4.3). A deploy runs its own synth
// with the deployer's --context and reads the real parameters.
// ---------------------------------------------------------------------------
const buildContext = ['--context identityParameterPlaceholders=true'].join(' ');
project.tasks.tryFind('synth:silent')?.reset(`cdk synth -q ${buildContext}`);
project.tasks.tryFind('synth')?.reset(`cdk synth ${buildContext}`);

// ---------------------------------------------------------------------------
// Deployment integration test (test/integ.ingestion.ts, scripts/integ.sh,
// spec §10). Deploys tenant-identity (shared-pool) unless one is already
// published, the test-aid stack and the demo stack, runs the steps, and
// always destroys what it deployed. Runs in EXACTLY ONE explicitly selected
// Region; the script fails fast when AWS_REGION is unset.
// ---------------------------------------------------------------------------
const integ = project.addTask('integ', {
  description:
    'Run the deployment integration test in $AWS_REGION (deploys stacks to the current AWS account)',
});
integ.exec('scripts/integ.sh');

// ---------------------------------------------------------------------------
// Exact version pins (supply chain). projen writes caret ranges for the
// toolchain it adds itself (eslint, jest, typescript, projen, constructs,
// ...). Pin every dependency that is not already exact to the version
// package-lock.json resolved, so package.json and the lock file agree and a
// fresh install cannot float. `npx projen upgrade` refreshes the lock file;
// the next `npx projen` re-pins.
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
