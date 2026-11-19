// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import { awscdk, javascript } from 'projen';

// The repository's shared pin. 2.274.0 already ships the L1 constructs of
// the EventBridge Custom Event Bus (aws-cdk-lib/aws-eventsv2, ADR-0002).
const cdkVersion = '2.274.0';

const project = new awscdk.AwsCdkTypeScriptApp({
  cdkVersion,
  defaultReleaseBranch: 'main',
  github: false,
  name: 'tenant-usage-metering',
  description:
    'Tenant usage metering for agentic applications: emitters admitted by signature and control-plane placement, a replayable raw store, hourly recounts driven by a run-time meter catalog, config-driven sinks and a usage bus',
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
      '# Tenant usage metering for agentic applications',
      '',
      'README pending (phase 7). The specification is design/tenant-usage-metering.spec.md;',
      'the decisions are in adr/ and the threats and mitigations in threat-model.md.',
      '',
    ].join('\n'),
  },
  minNodeVersion: '24.0.0',
  tsconfigDev: {
    compilerOptions: {
      skipLibCheck: true,
      isolatedModules: true,
    },
  },
  deps: [
    // Smithy SSDK runtime (generated code in src/smithy imports these)
    'tslib@2.8.1',
    '@aws-sdk/core@3.980.0',
    '@smithy/core@3.39.0',
    '@smithy/fetch-http-handler@5.8.0',
    '@smithy/node-http-handler@4.14.2',
    '@smithy/server-common@0.4.2',
    '@smithy/server-apigateway@0.3.3',
    '@smithy/types@4.20.0',
    // Runtime
    '@aws-sdk/client-dynamodb@3.1154.0', // the table (spec §4)
    '@aws-sdk/lib-dynamodb@3.1154.0',
    '@aws-sdk/util-dynamodb@3.996.9', // stream images (the record publisher)
    '@aws-sdk/client-s3@3.1154.0', // raw, error and export objects (spec §4.8)
    '@aws-sdk/client-firehose@3.1154.0', // ingestPath DIRECT and the ingest redrive (ADR-0002)
    '@aws-sdk/client-sqs@3.1154.0', // dead-letter queues, deliveries
    '@aws-sdk/client-secrets-manager@3.1154.0', // HTTP sink credentials (spec §4.4)
    '@aws-sdk/client-cloudwatch@3.1154.0', // unregistered-caller and dropped-refusal metrics (spec §3.2)
    '@aws-sdk/client-eventbridgev2@3.1154.0', // ingest and usage buses (Custom Event Bus, ADR-0002)
    '@aws-sdk/client-sfn@3.1154.0', // the scheduler starts recounts (spec §4.5)
    '@aws-sdk/client-lambda@3.1154.0', // the admin function starts jobs (spec §4.6)
    'ulid@3.0.2', // job ids, emitter snippet event ids (spec §4.6, §4.8)
    // SigV4 for AWS_IAM HTTP sinks (spec §4.4); the integration test signs its API calls with them too
    '@aws-sdk/credential-providers@3.1154.0',
    '@aws-crypto/sha256-js@5.2.0',
    '@smithy/protocol-http@5.6.2',
    '@smithy/signature-v4@5.7.5',
    // Security linting - AwsSolutionsChecks aspect applied in src/main.ts
    'cdk-nag@3.0.2',
  ],
  devDeps: [
    '@types/node@24.19.2',
    '@types/aws-lambda@8.10.164',
    'aws-sdk-client-mock@4.1.0',
    'aws-sdk-client-mock-jest@4.1.0',
    'esbuild@0.28.2', // local NodejsFunction bundling, no Docker needed
    // The integration test (test/integ.metering.ts)
    '@aws-sdk/client-cloudwatch-logs@3.1154.0', // reads the test receiver's log lines
  ],
  jestOptions: {
    jestConfig: {
      maxWorkers: 4,
      workerIdleMemoryLimit: '1GB',
      testPathIgnorePatterns: ['/node_modules/', '/test/integ/'],
      coveragePathIgnorePatterns: ['/node_modules/', '/test/', '/src/smithy/'],
    },
  },
});

// Smithy-generated SSDK output is not linted and not committed
project.eslint?.addIgnorePattern('src/smithy/**/*');
project.gitignore.exclude('src/smithy/');

// Local working notes and agent config - not part of the sample
project.gitignore.exclude('TODO.md');
project.gitignore.exclude('.kiro/');

// Machine output of the integration test and scanner-local state
project.gitignore.exclude('cdk.integ.out/');
project.gitignore.exclude('test/*.snapshot/');
project.gitignore.exclude('.holmes/');
project.gitignore.exclude('.ash/ash_output/');

// Regenerate the SSDK + OpenAPI document from the model before every compile
project.preCompileTask.exec('smithy build');

// The integration test (integration-test.md): deploy, run, destroy.
project.addTask('integ', {
  description: 'Deploy the demo stack, run test/integ.metering.ts, destroy the stack (needs AWS_REGION)',
  exec: 'bash scripts/integ.sh',
});

// ts-jest transpiles per file and reports no type errors, so the tests are
// type-checked here.
project.testTask.prependExec('tsc --noEmit -p test/tsconfig.json');

// ---------------------------------------------------------------------------
// Exact version pins (supply chain): pin every dependency that is not
// already exact to the version package-lock.json resolved.
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
