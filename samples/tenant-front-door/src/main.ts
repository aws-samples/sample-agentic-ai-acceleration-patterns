// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';

// The stacks (edge, main, edge logging, RouteHookAccess; spec §3.1) are
// built in later slices. The contracts slice ships the app shell with the
// security linting every sample applies.
const app = new App();

Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true, writeSuppressionsToCloudFormation: true }));

app.synth();
