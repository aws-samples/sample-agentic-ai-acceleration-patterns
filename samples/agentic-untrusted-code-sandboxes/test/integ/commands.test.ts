// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { destroyOnly, leftoversOnly } from './driver';
import { checkLeftovers } from './leftovers';
import { readState, writeState, type RunState } from './state';

jest.mock('./aws', () => ({ Aws: jest.fn() }));
jest.mock('./common', () => ({ ...jest.requireActual('./common'), runRegion: () => 'r', stackPrefix: () => 'P' }));
jest.mock('./deploy', () => ({ ...jest.requireActual('./deploy'), destroyStack: jest.fn(async () => ({ status: 'DELETE_COMPLETE', failures: [] })) }));
jest.mock('./leftovers', () => ({ ...jest.requireActual('./leftovers'), checkLeftovers: jest.fn() }));
jest.mock('./state', () => ({ ...jest.requireActual('./state'), readState: jest.fn(), writeState: jest.fn() }));

const STATE: RunState = { prefix: 'P', region: 'r', stackName: 'P', startedAt: 't', destroyed: false, resources: [], policyBaseline: {}, runtimeNames: [], imageNames: [] };
const UNAVAILABLE = [{ kind: 'check-unavailable', id: 'stacks', detail: 'the credentials expired' }];
const KNOWN = [{ kind: 'logs-resource-policy', id: 'p', detail: 'd', known: true }];

describe('the leftovers and destroy commands', () => {
  let out: jest.SpyInstance;
  beforeEach(() => {
    out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    (readState as jest.Mock).mockReturnValue(STATE);
    (writeState as jest.Mock).mockClear();
  });
  afterEach(() => out.mockRestore());

  test.each([
    { name: 'a check that could not run', findings: UNAVAILABLE, code: 1, destroyed: false },
    { name: 'only the known leftover', findings: KNOWN, code: 0, destroyed: true },
  ])('with $name, leftovers and destroy exit $code and destroy records destroyed $destroyed', async ({ findings, code, destroyed }) => {
    (checkLeftovers as jest.Mock).mockResolvedValue(findings);
    expect(await leftoversOnly()).toBe(code);
    expect(await destroyOnly()).toBe(code);
    expect(writeState).toHaveBeenCalledWith(expect.objectContaining({ destroyed }));
  });
});
