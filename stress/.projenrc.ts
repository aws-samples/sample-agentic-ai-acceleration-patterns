// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { javascript, typescript } from 'projen';

// The shared contract of the platform stress test (docs/stress-test.spec.md,
// stress ADR-0001): tiers, the slice declaration, the quota budget, the
// result records and the runner, plus the driver host (driver/, ADR-0007), the
// k6 library (k6/) and the cell account owner's stacks (application/, ADR-0006). Test
// assets only: the driver stack is deployed only while a run needs it; the owner stacks
// live in the standalone cell accounts.
const project = new typescript.TypeScriptProject({
  defaultReleaseBranch: 'main',
  github: false,
  name: 'aaa-stress',
  description: 'Shared contract of the platform stress test: tiers, slice declarations, quota budget, result records, the runner, the driver host and the k6 library',
  packageManager: javascript.NodePackageManager.NPM,
  license: 'MIT-0',
  copyrightOwner: 'Amazon.com, Inc. or its affiliates. All Rights Reserved.',
  copyrightPeriod: '',
  projenrcTs: true,
  projenVersion: '0.104.10',
  typescriptVersion: '5.9.3',
  minNodeVersion: '24.0.0',
  sampleCode: false,
  release: false,
  package: false,
  entrypoint: '',
  // The driver host stack (driver/), synthesised and deployed from here, so a sample
  // never loads a second copy of the CDK (ADR-0009). Versions match the samples. This
  // package is private and never published: `deps` only satisfies the linter's rule
  // that non-test code imports declared dependencies.
  deps: ['aws-cdk-lib@2.274.0', 'cdk-nag@3.0.2', 'constructs@10.8.1'],
  devDeps: ['@types/node@24', 'aws-cdk@2.1146.1'],
  tsconfigDev: {
    compilerOptions: {
      skipLibCheck: true,
      // The tests import k6/record.js, which is plain ES module JavaScript (no k6 import).
      allowJs: true,
    },
  },
  jestOptions: {
    jestConfig: {
      // k6/record.js is JavaScript: ts-jest compiles it to CommonJS like the TypeScript.
      transform: { '^.+\\.[tj]s$': new javascript.Transform('ts-jest', { tsconfig: 'test/tsconfig.json' }) },
    },
  },
});

// driver/ is TypeScript the tests and the linter cover; k6/ is k6 JavaScript, run by k6 only.
project.eslint?.addLintPattern('driver');
// The linter finds a file's types through the nearest tsconfig.json; driver/ gets its own,
// like test/ has (ts-node reads it too when deploy.sh runs app.ts).
new javascript.TypescriptConfig(project, {
  fileName: 'driver/tsconfig.json',
  extends: javascript.TypescriptConfigExtends.fromPaths(['../tsconfig.json']),
  include: ['**/*.ts'],
  compilerOptions: { noEmit: true, rootDir: '..', skipLibCheck: true },
});
// application/ holds the cell account owner's stacks, the cell policies and the /cell/ aspect
// (spec §8, decision 7; W-10), linted and type-checked like driver/.
project.eslint?.addLintPattern('application');
new javascript.TypescriptConfig(project, {
  fileName: 'application/tsconfig.json',
  extends: javascript.TypescriptConfigExtends.fromPaths(['../tsconfig.json']),
  include: ['**/*.ts'],
  compilerOptions: { noEmit: true, rootDir: '..', skipLibCheck: true },
});
// Machine output of the driver app (driver/deploy.sh) and its AZ lookup, which is keyed by account id.
project.gitignore.exclude('cdk.driver.out/');
// dashboard/ holds the run dashboard's CDK app, the widgets as data and the snapshot step
// (stress ADR-0022), linted and type-checked like driver/.
project.eslint?.addLintPattern('dashboard');
new javascript.TypescriptConfig(project, {
  fileName: 'dashboard/tsconfig.json',
  extends: javascript.TypescriptConfigExtends.fromPaths(['../tsconfig.json']),
  include: ['**/*.ts'],
  compilerOptions: { noEmit: true, rootDir: '..', skipLibCheck: true },
});
// Machine output of the dashboard app (dashboard/dashboard.sh).
project.gitignore.exclude('cdk.dashboard.out/');
project.gitignore.exclude('cdk.dashboard.sink.out/');
// Machine output of the cell account apps (application/*.sh).
project.gitignore.exclude('cdk.application.out/');
project.gitignore.exclude('cdk.context.json');

// Spikes are records of runs, not part of the contract's build.
project.eslint?.addIgnorePattern('spikes/**/*');
project.tsconfigDev.addExclude('spikes/**/*');

project.synth();
