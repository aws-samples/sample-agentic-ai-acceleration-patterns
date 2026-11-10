// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import { awscdk, javascript } from 'projen';

// Aligned with tenant-encrypted-ingestion, the newest sample (standard §4.1).
const cdkVersion = '2.274.0';
const sdkVersion = '3.1154.0';

const project = new awscdk.AwsCdkTypeScriptApp({
  cdkVersion,
  defaultReleaseBranch: 'main',
  github: false,
  name: 'tenant-memory-isolation',
  description:
    'Tenant memory isolation: one pooled AgentCore Memory behind an AgentCore Gateway with the native Memory connector, Cedar policies on signed tenant claims, and a resource fence around the Gateway',
  packageManager: javascript.NodePackageManager.NPM,
  license: 'MIT-0',
  copyrightOwner: 'Amazon.com, Inc. or its affiliates. All Rights Reserved.',
  copyrightPeriod: '',
  projenrcTs: true,
  // The README is hand-written (standard §7); projen writes one only when it is missing.
  readme: { filename: 'README.md', contents: '# Tenant memory isolation\n' },
  minNodeVersion: '24.0.0',
  tsconfigDev: {
    compilerOptions: {
      skipLibCheck: true,
      isolatedModules: true,
    },
  },
  deps: [
    // Security linting: the AwsSolutionsChecks aspect is applied in src/main.ts.
    'cdk-nag@3.0.2',
  ],
  devDeps: [
    '@types/node@24.19.2',
    '@types/aws-lambda@8.10.164',
    'esbuild@0.28.2', // local NodejsFunction bundling, no Docker needed
    '@cedar-policy/cedar-wasm@4.14.0', // the policies are evaluated by the real Cedar evaluator in the unit tests
    // The fence test enumerates the Memory data-plane client's operations (ADR-0007).
    `@aws-sdk/client-bedrock-agentcore@${sdkVersion}`,
    // The integration steps (test/integ/) and the demo script call these services.
    `@aws-sdk/client-bedrock-agentcore-control@${sdkVersion}`,
    `@aws-sdk/client-cognito-identity-provider@${sdkVersion}`,
    `@aws-sdk/client-iam@${sdkVersion}`,
    `@aws-sdk/client-sts@${sdkVersion}`,
    `@aws-sdk/client-ssm@${sdkVersion}`,
    `@aws-sdk/client-cloudwatch@${sdkVersion}`,
    `@aws-sdk/client-cloudwatch-logs@${sdkVersion}`,
    `@aws-sdk/client-resource-groups-tagging-api@${sdkVersion}`,
  ],
  jestOptions: {
    jestConfig: {
      maxWorkers: 4,
      workerIdleMemoryLimit: '1GB',
      // The integration steps run against a deployed stack through scripts/integ.sh.
      testPathIgnorePatterns: ['/node_modules/', '/test/integ/', 'integ\\.memory-isolation\\.ts$'],
      coveragePathIgnorePatterns: ['/node_modules/', '/test/'],
    },
  },
});

// Local working notes, agent configuration, and machine output are not committed (standard §1).
project.gitignore.exclude('TODO.md');
project.gitignore.exclude('.kiro/');
project.gitignore.exclude('cdk.integ.out/');
project.gitignore.exclude('test/*.snapshot/');
project.gitignore.exclude('integ-report*.json');
project.gitignore.exclude('.ash/ash_output/');

// ts-jest transpiles per file and reports no type errors, so the tests and
// the integration steps are type-checked here.
project.testTask.prependExec('tsc --noEmit -p test/tsconfig.json');

// ---------------------------------------------------------------------------
// Deployment integration test (test/integ.memory-isolation.ts driven by
// scripts/integ.sh, ADR-0010). Runs in exactly one Region: the script fails
// fast when AWS_REGION is unset.
// ---------------------------------------------------------------------------
project.addTask('integ', {
  description: 'Run the deployment integration test in $AWS_REGION (deploys to the current AWS account)',
}).exec('scripts/integ.sh');

// ---------------------------------------------------------------------------
// Exact version pins (standard §4.1): pin every dependency projen adds with a
// caret range to the version package-lock.json resolved.
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
