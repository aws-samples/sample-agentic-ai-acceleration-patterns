// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import { awscdk, Component, DependencyType, javascript } from 'projen';

// Same CDK and SDK pins as agentic-runtime-isolation (ADR-0023 records the
// premise check: the L1 and SDK pieces this sample needs exist at these pins).
const cdkVersion = '2.274.0';
const sdk = '3.1154.0';

// The producer of the gateway entry (ADR-0017). It is installed only from a
// checkout, never from a registry.
const producer = 'agentic-runtime-isolation';

const project = new awscdk.AwsCdkTypeScriptApp({
  cdkVersion,
  defaultReleaseBranch: 'main',
  github: false,
  name: 'agentic-untrusted-code-sandboxes',
  description:
    'Untrusted code sandboxes for agentic applications: one run_code tool that runs model-written Python for one tenant at a time in a per-tenant sandbox (Lambda MicroVMs, Nitro Sandboxes on ECS Managed Instances, or AgentCore Runtime), with no internet and no tenant credentials in the sandbox',
  packageManager: javascript.NodePackageManager.NPM,
  license: 'MIT-0',
  copyrightOwner: 'Amazon.com, Inc. or its affiliates. All Rights Reserved.',
  copyrightPeriod: '',
  projenrcTs: true,
  minNodeVersion: '24.0.0',
  tsconfigDev: {
    compilerOptions: {
      skipLibCheck: true,
      isolatedModules: true,
    },
  },
  tsconfig: {
    compilerOptions: {
      skipLibCheck: true,
    },
  },
  deps: [
    // Runtime clients of the tool, reaper, drain and offboard functions. Later
    // contributors do not add dependencies: scripts/CONVENTIONS.md.
    `@aws-sdk/client-lambda-microvms@${sdk}`, // RunMicrovm, GetMicrovm, ListMicrovms, TerminateMicrovm, CreateMicrovmAuthToken (microvm)
    `@aws-sdk/client-ecs@${sdk}`, // RunTask, DescribeTasks, ListTasks, StopTask, container instances (nitro, drain)
    `@aws-sdk/client-ec2@${sdk}`, // DescribeInstances in the drain (spec §5.3)
    `@aws-sdk/client-bedrock-agentcore@${sdk}`, // InvokeAgentRuntime, StopRuntimeSession (agentcore)
    `@aws-sdk/client-bedrock-agentcore-control@${sdk}`, // runtime reads in the drain and the integration test
    `@aws-sdk/client-dynamodb@${sdk}`, // the sandbox registry (spec §4.1)
    `@aws-sdk/lib-dynamodb@${sdk}`,
    `@aws-sdk/client-s3@${sdk}`, // inputs and outputs (spec §4.2)
    `@aws-sdk/client-sts@${sdk}`, // AssumeRole + TagSession for the tool tenant role (spec §3.2)
    `@aws-sdk/client-cloudwatch-logs@${sdk}`, // the log cleanup custom resource (spec §5.3)
    // Copies the runner image from the CDK asset repository into the
    // construct-owned runner repository (ADR-0024).
    'cdk-ecr-deployment@4.2.92',
    // The constructs build their Lambdas from TypeScript sources at the
    // consumer's synth (ADR-0017), so esbuild is a runtime dependency of the
    // package, not only of this repository's build.
    'esbuild@0.28.2',
  ],
  devDeps: [
    // Security linting in the demo app (src/main.ts) only; the construct
    // records its acknowledgments through aws-cdk-lib's Validations.
    'cdk-nag@3.0.2',
    '@types/node@24.19.2',
    '@types/aws-lambda@8.10.164',
    'aws-sdk-client-mock@4.1.0',
    'aws-sdk-client-mock-jest@4.1.0',
    // the integration test and its driver (spec §8)
    `@aws-sdk/client-lambda@${sdk}`, // invokes runCodeFunction and offboardFunction with IAM
    `@aws-sdk/client-iam@${sdk}`, // iam-wall: SimulatePrincipalPolicy
    `@aws-sdk/client-ssm@${sdk}`, // reads tenant-identity's published parameters
    `@aws-sdk/client-cognito-identity-provider@${sdk}`, // test users for the gateway steps
    `@aws-sdk/client-cloudformation@${sdk}`, // stack outputs
    // ADR-0017: the gateway entry builds and tests against a checkout of the producer.
    `${producer}@file:../${producer}`,
  ],
  jestOptions: {
    jestConfig: {
      maxWorkers: 4,
      workerIdleMemoryLimit: '1GB',
      testPathIgnorePatterns: ['/node_modules/', '/test/e2e/', '/lib/'],
      modulePathIgnorePatterns: ['<rootDir>/lib/'],
      coveragePathIgnorePatterns: ['/node_modules/', '/test/'],
    },
  },
});

// ---------------------------------------------------------------------------
// Package shape (ADR-0017): compiled lib/, two entries, the producer as an
// optional peer dependency, and the handler tree that ships the Lambda and
// runner sources the constructs build from.
// ---------------------------------------------------------------------------
project.package.addField('main', 'lib/index.js');
project.package.addField('types', 'lib/index.d.ts');
project.package.addField('exports', {
  '.': { types: './lib/index.d.ts', default: './lib/index.js' },
  './gateway': { types: './lib/gateway/index.d.ts', default: './lib/gateway/index.js' },
  './package.json': './package.json',
});
project.package.addField('typesVersions', { '*': { gateway: ['lib/gateway/index.d.ts'] } });
// An app project may not declare peer dependencies through projen, and
// projen rewrites the dependency fields after rendering, so the field is
// written once projen has finished with package.json.
class OptionalPeer extends Component {
  public postSynthesize(): void {
    // projen installs before this runs, so the lock file's root entry is
    // patched too, or `npm ci` would find the two out of step.
    for (const file of ['package.json', 'package-lock.json']) {
      if (!fs.existsSync(file)) continue;
      const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
      const target = file === 'package.json' ? doc : doc.packages?.[''];
      if (!target) continue;
      target.peerDependencies = { [producer]: '*' };
      const mode = fs.statSync(file).mode;
      fs.chmodSync(file, 0o644);
      fs.writeFileSync(file, `${JSON.stringify(doc, undefined, 2)}\n`);
      fs.chmodSync(file, mode);
    }
  }
}
new OptionalPeer(project);
// esbuild ships as a runtime dependency (above); projen also adds it as a dev one.
project.deps.removeDependency('esbuild', DependencyType.BUILD);
project.package.addField('peerDependenciesMeta', { [producer]: { optional: true } });
project.package.addField('files', [
  'lib/**/*.js',
  'lib/**/*.d.ts',
  'lib/handlers/**',
  // The demo app is not part of the package (it needs cdk-nag, a dev dependency).
  '!lib/main.*',
  '!lib/demo.cdk.*',
  'LICENSE',
  'README.md',
]);

// The app task "compile" is empty for a CDK app; this package emits lib/.
project.compileTask.exec('tsc --build');
// Copy every src/**/*.function.ts, the modules it imports, and the runner
// sources into lib/handlers/ (ADR-0017, ADR-0023). It runs before synth.
project.postCompileTask.prependExec('ts-node --project projenrc/tsconfig.json projenrc/copy-handlers.ts');

// ---------------------------------------------------------------------------
// The core entry never reaches the producer (spec §3.3, ADR-0017). The
// gateway entry and the demo app files may import it.
// ---------------------------------------------------------------------------
project.eslint?.addOverride({
  files: ['src/**/*.ts'],
  excludedFiles: ['src/gateway/**', 'src/main.ts', 'src/demo.cdk.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: [producer, `${producer}/*`, `**/${producer}/**`],
            message: 'The core entry must not import agentic-runtime-isolation (ADR-0017); only src/gateway/ may.',
          },
        ],
      },
    ],
  },
});

// The demo app may import dev dependencies (cdk-nag); it is not in the package.
project.eslint?.addOverride({
  files: ['src/main.ts'],
  rules: { 'import/no-extraneous-dependencies': ['error', { devDependencies: true }] },
});

// ---------------------------------------------------------------------------
// Checks that `npx projen build` runs besides jest and eslint (ADR-0026):
// the runner's Python unit tests, the license header on every authored
// file that is not TypeScript, and the terminology and account-id grep.
// ---------------------------------------------------------------------------
const testRunner = project.addTask('test:runner', {
  description: 'Python unit tests of the runner and the protocol vectors',
});
testRunner.exec('python3 -B -m unittest discover -s runner/tests -t .');
// The runner's kernel-level checks (uid drop, rlimits, seccomp, sweep, cgroups) need root: unittest skips them in a plain build.
// A pipeline sets RUNNER_REQUIRE_LINUX_TESTS=1 so a skip fails the build, and runs this task on an x86_64 Docker host.
const testRunnerLinux = project.addTask('test:runner:linux', {
  description: 'The runner tests that need root, in privileged containers (x86_64 Docker host)',
});
testRunnerLinux.exec('scripts/test-runner-docker.sh');
// The deployment integration test (spec §8, integration-test.md): not part of the build, run by hand in a test account.
const integ = project.addTask('integ', {
  description: 'Deployment integration test: deploy, every step of integration-test.md, destroy (needs AWS_REGION)',
});
integ.exec('scripts/integ.sh');
const checkHeaders = project.addTask('check:headers', {
  description: 'MIT-0 header on every authored .py, Dockerfile and shell file',
});
checkHeaders.exec('scripts/check-headers.sh');
const checkTerms = project.addTask('check:terms', {
  description: 'No banned terms, account ids or account aliases in the tree',
});
checkTerms.exec('scripts/check-terms.sh');
project.testTask.spawn(testRunner);
project.testTask.spawn(checkHeaders);
project.testTask.spawn(checkTerms);

// Local working notes, scanner state and machine output stay out of git.
project.gitignore.exclude('TODO.md');
project.gitignore.exclude('.kiro/');
project.gitignore.exclude('cdk.integ.out/');
project.gitignore.exclude('cdk.context.json');
project.gitignore.exclude('.holmes/');
project.gitignore.exclude('.ash/ash_output/');
project.gitignore.exclude('__pycache__/');

// ---------------------------------------------------------------------------
// Build-time synth context (standard §4.3): the demo app needs only real
// choices, so the build passes every backend and the standalone entry.
// src/main.ts fails fast without them.
// ---------------------------------------------------------------------------
const buildContext = [
  '--context backends=microvm,nitro,agentcore',
  '--context standalone=true',
].join(' ');
project.tasks.tryFind('synth:silent')?.reset(`cdk synth -q ${buildContext}`);
project.tasks.tryFind('synth')?.reset(`cdk synth ${buildContext}`);

// ---------------------------------------------------------------------------
// Exact version pins (as agentic-runtime-isolation): every dependency that
// projen wrote as a range is pinned to what package-lock.json resolved.
// ---------------------------------------------------------------------------
if (fs.existsSync('package-lock.json')) {
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8')) as {
    packages?: Record<string, { version?: string }>;
  };
  for (const dep of project.deps.all) {
    if (dep.name === producer) continue;
    const resolved = lock.packages?.[`node_modules/${dep.name}`]?.version;
    const exact = dep.version !== undefined && /^\d+\.\d+\.\d+/.test(dep.version);
    if (!exact && resolved !== undefined && dep.type !== 'peer') {
      project.deps.addDependency(`${dep.name}@${resolved}`, dep.type);
    }
  }
}

project.synth();
