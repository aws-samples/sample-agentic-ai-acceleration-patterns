// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { ValidationException } from '../../src/smithy/source/typescript-ssdk-codegen/src';
import {
  checkParameterValue,
  mergeCellParameters,
  mergeDeploymentParameters,
  parametersAsReadCondition,
  resolveParameters,
  StoredCellParameterDeclaration,
  StoredParameterDeclaration,
  validateCreateParameters,
  validateDeclarations,
} from '../../src/tenant/parameters';

const declarations: StoredParameterDeclaration[] = [
  { name: 'ALLOWED_EMAIL_DOMAIN', required: true },
  { name: 'LOG_LEVEL', required: false, default: 'info' },
  { name: 'FEATURE', required: false },
];
const cellDeclarations: StoredCellParameterDeclaration[] = [{ name: 'CELL_SIZE', default: 'small' }];

/** The ValidationException message a call throws (fails the test when it does not throw one). */
function refusal(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationException);
    return (error as ValidationException).message ?? '';
  }
  throw new Error('expected a ValidationException');
}

describe('validateDeclarations (PutApplication, §4.1, §5.5)', () => {
  test('normalises the sent lists: required defaults to false, optional fields omitted when absent', () => {
    expect(
      validateDeclarations({
        parameters: [{ name: 'ALLOWED_EMAIL_DOMAIN', required: true }, { name: 'LOG_LEVEL', default: 'info', description: 'd' }],
        cellParameters: [{ name: 'CELL_SIZE', default: 'small' }],
      }),
    ).toEqual({
      parameters: [
        { name: 'ALLOWED_EMAIL_DOMAIN', required: true },
        { name: 'LOG_LEVEL', required: false, default: 'info', description: 'd' },
      ],
      cellParameters: [{ name: 'CELL_SIZE', default: 'small' }],
    });
  });

  test('a list that is not sent comes back undefined (kept); [] comes back [] (clears)', () => {
    expect(validateDeclarations({})).toEqual({ parameters: undefined, cellParameters: undefined });
    expect(validateDeclarations({ parameters: [], cellParameters: [] })).toEqual({ parameters: [], cellParameters: [] });
  });

  test.each([
    ['a lower-case name', { parameters: [{ name: 'log_level' }] }, /not a valid parameter name/],
    ['a duplicate tenant name', { parameters: [{ name: 'A' }, { name: 'A' }] }, /parameters: A is declared more than once/],
    ['a duplicate cell name', { cellParameters: [{ name: 'A', default: 'x' }, { name: 'A', default: 'y' }] }, /cellParameters: A is declared more than once/],
    ['a required parameter with a default', { parameters: [{ name: 'A', required: true, default: 'x' }] }, /A is required and so cannot have a default/],
    ['a cell parameter without a default', { cellParameters: [{ name: 'A', default: undefined }] }, /A has no default/],
    ['one name in both lists', { parameters: [{ name: 'A' }], cellParameters: [{ name: 'A', default: 'x' }] }, /A is declared in both/],
    ['a default over 1,024 bytes', { parameters: [{ name: 'A', default: 'é'.repeat(513) }] }, /1026 bytes/],
    ['a default with a control character', { cellParameters: [{ name: 'A', default: 'a\u0000b' }] }, /control character/],
    ['21 declarations', { parameters: Array.from({ length: 21 }, (_, i) => ({ name: `P${i}` })) }, /at most 20/],
  ])('%s is a 400', (_, input, message) => {
    expect(refusal(() => validateDeclarations(input as any))).toMatch(message);
  });

  test('the cross-list check runs against a kept list as well as the sent ones', () => {
    // Sends cellParameters only; the kept tenant list already has the name.
    expect(
      refusal(() =>
        validateDeclarations({
          cellParameters: [{ name: 'LOG_LEVEL', default: 'x' }],
          keptParameters: declarations,
        }),
      ),
    ).toMatch(/LOG_LEVEL is declared in both/);
    expect(
      refusal(() => validateDeclarations({ parameters: [{ name: 'CELL_SIZE' }], keptCellParameters: cellDeclarations })),
    ).toMatch(/CELL_SIZE is declared in both/);
    // A sent list replaces the kept one in the check.
    expect(() =>
      validateDeclarations({ parameters: [{ name: 'CELL_SIZE' }], cellParameters: [], keptCellParameters: cellDeclarations }),
    ).not.toThrow();
  });

  test('error messages never carry a default', () => {
    expect(refusal(() => validateDeclarations({ parameters: [{ name: 'A', default: 'sensitive\u0001' }] }))).not.toContain('sensitive');
  });
});

describe('checkParameterValue (R-33)', () => {
  test('counts UTF-8 bytes, not characters: 1,024 bytes pass, 1,025 fail', () => {
    expect(() => checkParameterValue('A', 'a'.repeat(1024), 'value')).not.toThrow();
    expect(() => checkParameterValue('A', 'é'.repeat(512), 'value')).not.toThrow();
    expect(refusal(() => checkParameterValue('A', `${'é'.repeat(512)}a`, 'value'))).toMatch(/1025 bytes/);
  });

  test.each(['\u0000', '\u001F', '\u007F', '\n', '\t'])('refuses control character %j', (character) => {
    expect(refusal(() => checkParameterValue('A', `x${character}y`, 'value'))).toMatch(/control character/);
  });

  test('accepts an empty string, which is a value, not a deletion', () => {
    expect(() => checkParameterValue('A', '', 'value')).not.toThrow();
  });
});

describe('validateCreateParameters (CreateDeployment, R-33)', () => {
  test('returns the supplied values as given, never a default', () => {
    expect(validateCreateParameters({ ALLOWED_EMAIL_DOMAIN: 'example.com' }, declarations, cellDeclarations)).toEqual({
      ALLOWED_EMAIL_DOMAIN: 'example.com',
    });
  });

  test('no declarations and no values is an empty map', () => {
    expect(validateCreateParameters(undefined, undefined, undefined)).toEqual({});
  });

  test('a missing required parameter is a 400 naming it', () => {
    expect(refusal(() => validateCreateParameters({}, declarations, cellDeclarations))).toMatch(/without a value: ALLOWED_EMAIL_DOMAIN/);
  });

  test('an undeclared name is a 400; a cell parameter name says where it belongs', () => {
    expect(refusal(() => validateCreateParameters({ ALLOWED_EMAIL_DOMAIN: 'x', NOPE: 'y' }, declarations, cellDeclarations))).toMatch(
      /NOPE is not declared/,
    );
    expect(
      refusal(() => validateCreateParameters({ ALLOWED_EMAIL_DOMAIN: 'x', CELL_SIZE: 'y' }, declarations, cellDeclarations)),
    ).toMatch(/cell parameter; set it on the cell with UpdateCell/);
  });

  test('a bad value is a 400 that names the parameter and not the value', () => {
    const message = refusal(() => validateCreateParameters({ ALLOWED_EMAIL_DOMAIN: 'bad\u0007value' }, declarations, cellDeclarations));
    expect(message).toMatch(/ALLOWED_EMAIL_DOMAIN/);
    expect(message).not.toContain('bad');
  });
});

describe('mergeDeploymentParameters (UpdateDeployment, R-33)', () => {
  const stored = { ALLOWED_EMAIL_DOMAIN: 'example.com', STALE: 'old' };
  const merge = (set?: Record<string, string>, remove?: string[], from: Record<string, string> | undefined = stored) =>
    mergeDeploymentParameters({ stored: from, set, remove, declarations, cellDeclarations });

  test('an empty body keeps every stored value, stale ones included', () => {
    expect(merge()).toEqual(stored);
  });

  test('sets the named values and keeps the rest', () => {
    expect(merge({ LOG_LEVEL: 'debug' })).toEqual({ ...stored, LOG_LEVEL: 'debug' });
  });

  test('removes a stale (undeclared) value; a name that is not stored is a no-op', () => {
    expect(merge(undefined, ['STALE', 'FEATURE'])).toEqual({ ALLOWED_EMAIL_DOMAIN: 'example.com' });
  });

  test('a record with no map yet merges from nothing', () => {
    expect(
      mergeDeploymentParameters({ stored: undefined, set: { ALLOWED_EMAIL_DOMAIN: 'x' }, remove: undefined, declarations, cellDeclarations }),
    ).toEqual({ ALLOWED_EMAIL_DOMAIN: 'x' });
  });

  test('a name in both lists is a 400', () => {
    expect(refusal(() => merge({ LOG_LEVEL: 'x' }, ['LOG_LEVEL']))).toMatch(/LOG_LEVEL is in both/);
  });

  test('removing a required parameter is a 400', () => {
    expect(refusal(() => merge(undefined, ['ALLOWED_EMAIL_DOMAIN']))).toMatch(/ALLOWED_EMAIL_DOMAIN is a required parameter/);
  });

  test('a newly required parameter without a stored value is a 400 naming it, even with an empty body', () => {
    const now = [...declarations, { name: 'TIER', required: true }];
    expect(refusal(() => mergeDeploymentParameters({ stored, set: undefined, remove: undefined, declarations: now, cellDeclarations }))).toMatch(
      /without a value: TIER/,
    );
  });

  test('a cell parameter name is undeclared here, with a hint', () => {
    expect(refusal(() => merge({ CELL_SIZE: 'large' }))).toMatch(/CELL_SIZE is not declared.*cell parameter/);
  });

  test('more than 20 stored values after the merge is a 400', () => {
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`STALE_${i}`, 'v']));
    expect(refusal(() => merge({ ALLOWED_EMAIL_DOMAIN: 'x' }, undefined, many))).toMatch(/at most 20 .* would leave 21/);
  });

  test('more than 40 removeParameters names is a 400', () => {
    expect(refusal(() => merge(undefined, Array.from({ length: 41 }, (_, i) => `N${i}`)))).toMatch(/at most 40/);
  });
});

describe('mergeCellParameters (UpdateCell, R-34)', () => {
  const merge = (set?: Record<string, string>, remove?: string[], stored: Record<string, string> | undefined = {}) =>
    mergeCellParameters({ stored, set, remove, cellDeclarations, declarations });

  test('sets a declared cell parameter', () => {
    expect(merge({ CELL_SIZE: 'large' })).toEqual({ CELL_SIZE: 'large' });
  });

  test('removing the stored value empties the map (the cell returns to the default)', () => {
    expect(merge(undefined, ['CELL_SIZE'], { CELL_SIZE: 'large' })).toEqual({});
  });

  test('a tenant parameter name or an undeclared name is a 400', () => {
    expect(refusal(() => merge({ LOG_LEVEL: 'debug' }))).toMatch(/LOG_LEVEL is not declared.*tenant parameter/);
    expect(refusal(() => merge({ NOPE: 'x' }))).toMatch(/NOPE is not declared in the application's cellParameters$/);
  });

  test('a name in both lists, or a control character, is a 400', () => {
    expect(refusal(() => merge({ CELL_SIZE: 'x' }, ['CELL_SIZE']))).toMatch(/in both/);
    expect(refusal(() => merge({ CELL_SIZE: 'x\u0000' }))).toMatch(/control character/);
  });
});

describe('resolveParameters (R-32, R-34)', () => {
  test('stored values plus the defaults of declared names without one, name-sorted', () => {
    expect(Object.entries(resolveParameters({ ALLOWED_EMAIL_DOMAIN: 'example.com' }, declarations))).toEqual([
      ['ALLOWED_EMAIL_DOMAIN', 'example.com'],
      ['LOG_LEVEL', 'info'],
    ]);
  });

  test('a stored value wins over the default', () => {
    expect(resolveParameters({ LOG_LEVEL: 'debug' }, declarations)).toEqual({ LOG_LEVEL: 'debug' });
  });

  test('a declared name with neither a value nor a default is absent, never empty', () => {
    expect(resolveParameters({}, declarations)).not.toHaveProperty('FEATURE');
  });

  test('a stored value whose name is no longer declared is still passed', () => {
    expect(resolveParameters({ STALE: 'old' }, [])).toEqual({ STALE: 'old' });
  });

  test('a cell with no values of its own gets the cell defaults; no declarations, no parameters', () => {
    expect(resolveParameters({}, cellDeclarations)).toEqual({ CELL_SIZE: 'small' });
    expect(resolveParameters(undefined, undefined)).toEqual({});
  });
});

describe('parametersAsReadCondition (R-33)', () => {
  test('absent and {} are different reads', () => {
    expect(parametersAsReadCondition(undefined)).toEqual({
      conditionExpression: 'attribute_not_exists(#parameters)',
      expressionAttributeNames: { '#parameters': 'parameters' },
    });
    expect(parametersAsReadCondition({})).toEqual({
      conditionExpression: '#parameters = :readParameters',
      expressionAttributeNames: { '#parameters': 'parameters' },
      expressionAttributeValues: { ':readParameters': {} },
    });
    expect(parametersAsReadCondition({ A: 'x' }).expressionAttributeValues).toEqual({ ':readParameters': { A: 'x' } });
  });
});
