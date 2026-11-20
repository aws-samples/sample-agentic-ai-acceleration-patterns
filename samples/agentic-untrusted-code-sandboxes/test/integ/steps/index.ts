// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The step implementations by name. The driver itself runs the steps that
 * are not here, because they wrap the deploy: `standalone-build` and `synth`
 * (before it) and `teardown` (after it).
 */

import { type Ctx } from '../ctx';
import { type Unit } from '../steps';
import {
  apart, deadHandle, forged, iamWall, offboard, parse, prefix, race, recycledAddress, reuse, seed, standalone,
} from './basic';
import { coldFromZero, failedStart, idle, maxLife, microvmStop, telemetry } from './lifecycle';
import { dns, dnsPlatform, limits, noCredentials, noEgress, runaway, sessionFiles } from './probes';

export type StepImpl = (c: Ctx, u: Unit) => Promise<void>;

export const IMPLS: Readonly<Record<string, StepImpl>> = {
  'seed': (c) => seed(c),
  'parse': parse,
  'reuse': reuse,
  'apart': apart,
  'race': race,
  'prefix': prefix,
  'iam-wall': (c) => iamWall(c),
  'limits': limits,
  'no-credentials': noCredentials,
  'no-egress': noEgress,
  'dns': dns,
  'runaway': runaway,
  'session-files': (c) => sessionFiles(c),
  'standalone': standalone,
  'forged': (c) => forged(c),
  'dead-handle': deadHandle,
  'recycled-address': (c) => recycledAddress(c),
  'microvm-stop': (c) => microvmStop(c),
  'idle': (c) => idle(c),
  'cold-from-zero': (c) => coldFromZero(c),
  'max-life': (c) => maxLife(c),
  'failed-start': failedStart,
  'offboard': (c) => offboard(c),
  'telemetry': telemetry,
  'dns-platform': (c) => dnsPlatform(c),
};

/** Steps the driver runs around the deploy itself. */
export const DRIVER_STEPS: readonly string[] = ['standalone-build', 'synth', 'teardown'];
