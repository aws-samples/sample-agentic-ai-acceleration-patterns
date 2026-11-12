// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { WriteCondition } from '../shared/repository';
import {
  CellParameterDeclaration,
  ParameterDeclaration,
  ValidationException,
} from '../smithy/source/typescript-ssdk-codegen/src';

/**
 * Declared deployment parameters (ADR-039) and cell parameters (ADR-040):
 * validation of declarations and values, the `UpdateDeployment` /
 * `UpdateCell` merge, and resolution of a build's parameter set (spec
 * R-32, R-33, R-34). Pure functions: the service reads the records, these
 * decide, the service writes.
 *
 * Error messages name parameters, never values (spec N-11): a value may be
 * anything an operator typed, and messages reach logs and clients.
 */

/** At most this many declarations in each of an application's two lists (§4.1). */
export const MAX_DECLARATIONS = 20;
/** At most this many values stored on a deployment or a cell (§4.2, §4.4). */
export const MAX_STORED_VALUES = 20;
/** At most this many names in one `removeParameters` list (R-33). */
export const MAX_REMOVE_NAMES = 40;
/** A value or default holds at most this many bytes of UTF-8 (R-33). */
export const MAX_VALUE_BYTES = 1024;
/** The parameter name pattern (§4.1); the script receives `PARAM_<NAME>`. */
export const PARAMETER_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Characters a value must not hold: U+0000 to U+001F and U+007F (R-33). */
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/;

/** Parameter values by name, as stored on a deployment or a cell. */
export type ParameterValues = Readonly<Record<string, string>>;

/** A tenant parameter declaration as stored on the application record (`required` always set). */
export interface StoredParameterDeclaration {
  readonly name: string;
  readonly required: boolean;
  readonly default?: string;
  readonly description?: string;
}

/** A cell parameter declaration as stored on the application record. */
export interface StoredCellParameterDeclaration {
  readonly name: string;
  readonly default: string;
  readonly description?: string;
}

/** Which record a set of values belongs to; shapes the messages. */
type ValueOwner = 'deployment' | 'cell';

function invalid(message: string): ValidationException {
  return new ValidationException({ message });
}

/**
 * Checks one value or default (R-33): at most {@link MAX_VALUE_BYTES} bytes
 * of UTF-8 and no control character. A build environment cannot carry NUL,
 * and the rule bounds a value's JSON-encoded size at twice its raw size, so
 * the execution input stays inside the Step Functions limit (§8.1).
 */
export function checkParameterValue(name: string, value: string, what: 'value' | 'default'): void {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > MAX_VALUE_BYTES) {
    throw invalid(`Parameter ${name}: the ${what} is ${bytes} bytes of UTF-8; at most ${MAX_VALUE_BYTES} are allowed`);
  }
  if (CONTROL_CHARACTER.test(value)) {
    throw invalid(`Parameter ${name}: the ${what} holds a control character (U+0000 to U+001F or U+007F), which is not allowed`);
  }
}

function checkName(name: string, where: string): void {
  if (!PARAMETER_NAME_PATTERN.test(name)) {
    throw invalid(`${where}: ${JSON.stringify(name)} is not a valid parameter name (${PARAMETER_NAME_PATTERN.source})`);
  }
}

function checkUnique(names: readonly string[], list: string): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      throw invalid(`${list}: ${name} is declared more than once`);
    }
    seen.add(name);
  }
}

/**
 * Validates a `PutApplication` request's declarations as a whole (§4.1,
 * §5.5) and returns the lists to write, normalised (`required` always set).
 * A list the request did not send is returned as `undefined` (kept, R-29);
 * `kept` holds the current lists for the "one name in one list" check,
 * which runs against the sent lists plus the kept ones.
 */
export function validateDeclarations(input: {
  readonly parameters?: readonly ParameterDeclaration[];
  readonly cellParameters?: readonly CellParameterDeclaration[];
  readonly keptParameters?: readonly StoredParameterDeclaration[];
  readonly keptCellParameters?: readonly StoredCellParameterDeclaration[];
}): {
    readonly parameters?: StoredParameterDeclaration[];
    readonly cellParameters?: StoredCellParameterDeclaration[];
  } {
  let parameters: StoredParameterDeclaration[] | undefined;
  if (input.parameters !== undefined) {
    if (input.parameters.length > MAX_DECLARATIONS) {
      throw invalid(`parameters: at most ${MAX_DECLARATIONS} declarations are allowed, got ${input.parameters.length}`);
    }
    parameters = input.parameters.map((declaration) => {
      const name = declaration.name ?? '';
      checkName(name, 'parameters');
      const required = declaration.required === true;
      if (required && declaration.default !== undefined) {
        throw invalid(`parameters: ${name} is required and so cannot have a default`);
      }
      if (declaration.default !== undefined) {
        checkParameterValue(name, declaration.default, 'default');
      }
      return {
        name,
        required,
        ...(declaration.default === undefined ? {} : { default: declaration.default }),
        ...(declaration.description === undefined ? {} : { description: declaration.description }),
      };
    });
    checkUnique(parameters.map((p) => p.name), 'parameters');
  }

  let cellParameters: StoredCellParameterDeclaration[] | undefined;
  if (input.cellParameters !== undefined) {
    if (input.cellParameters.length > MAX_DECLARATIONS) {
      throw invalid(`cellParameters: at most ${MAX_DECLARATIONS} declarations are allowed, got ${input.cellParameters.length}`);
    }
    cellParameters = input.cellParameters.map((declaration) => {
      const name = declaration.name ?? '';
      checkName(name, 'cellParameters');
      if (declaration.default === undefined) {
        // A cell is created by placement, when no operator is present to
        // supply a value (ADR-040).
        throw invalid(`cellParameters: ${name} has no default; every cell parameter needs one`);
      }
      checkParameterValue(name, declaration.default, 'default');
      return {
        name,
        default: declaration.default,
        ...(declaration.description === undefined ? {} : { description: declaration.description }),
      };
    });
    checkUnique(cellParameters.map((p) => p.name), 'cellParameters');
  }

  // One name, one meaning across the application (§4.1, §6.1).
  const tenantNames = new Set((parameters ?? input.keptParameters ?? []).map((p) => p.name));
  for (const declaration of cellParameters ?? input.keptCellParameters ?? []) {
    if (tenantNames.has(declaration.name)) {
      throw invalid(`${declaration.name} is declared in both parameters and cellParameters; a name may appear in one list only`);
    }
  }
  return { parameters, cellParameters };
}

/**
 * Validates the values of a `CreateDeployment` (R-33) against the
 * application's current declarations and returns the map to store. An
 * undeclared name, a bad value or a required parameter without a value is a
 * 400; the error names the parameter.
 */
export function validateCreateParameters(
  supplied: ParameterValues | undefined,
  declarations: readonly StoredParameterDeclaration[] | undefined,
  cellDeclarations: readonly StoredCellParameterDeclaration[] | undefined,
): Record<string, string> {
  const values = { ...(supplied ?? {}) };
  checkSetNames(values, 'deployment', declarations ?? [], cellDeclarations ?? []);
  checkCount(values, 'deployment');
  checkRequiredPresent(values, declarations ?? []);
  return values;
}

/**
 * The `UpdateDeployment` merge (R-33): names in `set` are set, names in
 * `remove` removed, every other stored value kept. Validated against the
 * application's current declarations before anything is written; returns
 * the whole merged map, which the service writes in one `SET` with the
 * transition to `UPDATING`.
 */
export function mergeDeploymentParameters(input: {
  readonly stored: ParameterValues | undefined;
  readonly set: ParameterValues | undefined;
  readonly remove: readonly string[] | undefined;
  readonly declarations: readonly StoredParameterDeclaration[] | undefined;
  readonly cellDeclarations: readonly StoredCellParameterDeclaration[] | undefined;
}): Record<string, string> {
  const declarations = input.declarations ?? [];
  const set = input.set ?? {};
  const remove = input.remove ?? [];
  checkRemove(set, remove);
  checkSetNames(set, 'deployment', declarations, input.cellDeclarations ?? []);
  for (const name of remove) {
    if (declarations.some((d) => d.name === name && d.required)) {
      throw invalid(`removeParameters: ${name} is a required parameter and cannot be removed; set a new value instead`);
    }
  }
  const merged = applyMerge(input.stored, set, remove);
  checkCount(merged, 'deployment');
  checkRequiredPresent(merged, declarations);
  return merged;
}

/**
 * The `UpdateCell` merge (R-34): the rules of R-33 against the
 * application's `cellParameters`. A tenant parameter name is undeclared
 * here; removing a stored value returns the cell to the default.
 */
export function mergeCellParameters(input: {
  readonly stored: ParameterValues | undefined;
  readonly set: ParameterValues | undefined;
  readonly remove: readonly string[] | undefined;
  readonly cellDeclarations: readonly StoredCellParameterDeclaration[] | undefined;
  readonly declarations: readonly StoredParameterDeclaration[] | undefined;
}): Record<string, string> {
  const set = input.set ?? {};
  const remove = input.remove ?? [];
  checkRemove(set, remove);
  checkSetNames(set, 'cell', input.cellDeclarations ?? [], input.declarations ?? []);
  const merged = applyMerge(input.stored, set, remove);
  checkCount(merged, 'cell');
  return merged;
}

/**
 * A build's resolved parameter set (R-32, R-34): every stored value, plus
 * the declared default of each declaration without one. Stored values for
 * names no longer declared are still passed; a declaration with neither a
 * value nor a default is absent. Keys come out name-sorted.
 */
export function resolveParameters(
  stored: ParameterValues | undefined,
  declarations: readonly { readonly name: string; readonly default?: string }[] | undefined,
): Record<string, string> {
  const resolved: Record<string, string> = { ...(stored ?? {}) };
  for (const declaration of declarations ?? []) {
    if (declaration.default !== undefined && !Object.prototype.hasOwnProperty.call(resolved, declaration.name)) {
      resolved[declaration.name] = declaration.default;
    }
  }
  return Object.fromEntries(Object.entries(resolved).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * The guard that the `parameters` attribute is exactly as the request read
 * it (R-33, R-34): `attribute_not_exists` when it was absent, equality when
 * present, an empty map included. Absent and `{}` are different reads; a
 * guard that treated them alike could never pass on one of them.
 */
export function parametersAsReadCondition(read: ParameterValues | undefined): WriteCondition {
  return read === undefined
    ? { conditionExpression: 'attribute_not_exists(#parameters)', expressionAttributeNames: { '#parameters': 'parameters' } }
    : {
      conditionExpression: '#parameters = :readParameters',
      expressionAttributeNames: { '#parameters': 'parameters' },
      expressionAttributeValues: { ':readParameters': read },
    };
}

function checkRemove(set: ParameterValues, remove: readonly string[]): void {
  if (remove.length > MAX_REMOVE_NAMES) {
    throw invalid(`removeParameters: at most ${MAX_REMOVE_NAMES} names are allowed, got ${remove.length}`);
  }
  for (const name of remove) {
    checkName(name, 'removeParameters');
    if (Object.prototype.hasOwnProperty.call(set, name)) {
      throw invalid(`${name} is in both parameters and removeParameters; name it in one list only`);
    }
  }
}

function checkSetNames(
  set: ParameterValues,
  owner: ValueOwner,
  own: readonly { readonly name: string }[],
  other: readonly { readonly name: string }[],
): void {
  for (const [name, value] of Object.entries(set)) {
    if (!own.some((d) => d.name === name)) {
      const hint = other.some((d) => d.name === name)
        ? owner === 'deployment'
          ? ' (it is a cell parameter; set it on the cell with UpdateCell)'
          : ' (it is a tenant parameter; set it on a deployment)'
        : '';
      const list = owner === 'deployment' ? 'parameters' : 'cellParameters';
      throw invalid(`Parameter ${name} is not declared in the application's ${list}${hint}`);
    }
    checkParameterValue(name, value, 'value');
  }
}

function checkCount(values: ParameterValues, owner: ValueOwner): void {
  const count = Object.keys(values).length;
  if (count > MAX_STORED_VALUES) {
    throw invalid(`A ${owner} holds at most ${MAX_STORED_VALUES} parameter values; this request would leave ${count}`);
  }
}

function checkRequiredPresent(values: ParameterValues, declarations: readonly StoredParameterDeclaration[]): void {
  const missing = declarations
    .filter((d) => d.required && !Object.prototype.hasOwnProperty.call(values, d.name))
    .map((d) => d.name);
  if (missing.length > 0) {
    throw invalid(`Required parameter${missing.length > 1 ? 's' : ''} without a value: ${missing.join(', ')}`);
  }
}

function applyMerge(
  stored: ParameterValues | undefined,
  set: ParameterValues,
  remove: readonly string[],
): Record<string, string> {
  const merged: Record<string, string> = { ...(stored ?? {}), ...set };
  for (const name of remove) {
    delete merged[name];
  }
  return merged;
}
