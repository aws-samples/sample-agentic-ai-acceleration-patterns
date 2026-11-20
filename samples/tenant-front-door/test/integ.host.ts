// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The integration test's CDK app in `host` mode (spec §10). Run it through
 * `scripts/integ.sh host` (`npx projen integ`), which passes the `integ`
 * context phase by phase; see test/integ/stacks.ts and integration-test.md.
 */

import { App } from 'aws-cdk-lib';
import { buildIntegApp } from './integ/stacks';

const app = new App();
buildIntegApp(app, 'host');
app.synth();
