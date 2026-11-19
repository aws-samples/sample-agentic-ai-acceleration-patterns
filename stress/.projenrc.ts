// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { javascript, typescript } from 'projen';

// The shared contract of the platform stress test (docs/stress-test.spec.md,
// stress ADR-0001): tiers, the slice declaration, the quota budget, the
// result records and the runner. Test assets only: nothing here is deployed.
const project = new typescript.TypeScriptProject({
  defaultReleaseBranch: 'main',
  github: false,
  name: 'aaa-stress',
  description: 'Shared contract of the platform stress test: tiers, slice declarations, quota budget, result records and the runner',
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
  devDeps: ['@types/node@24'],
  tsconfigDev: {
    compilerOptions: {
      skipLibCheck: true,
    },
  },
});

// Spikes are records of runs, not part of the contract's build.
project.eslint?.addIgnorePattern('spikes/**/*');
project.tsconfigDev.addExclude('spikes/**/*');

project.synth();
