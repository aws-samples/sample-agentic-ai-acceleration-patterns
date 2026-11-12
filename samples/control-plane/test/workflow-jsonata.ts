// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import jsonata from 'jsonata';

/**
 * Evaluates the JSONata of a synthesized workflow state the way Step
 * Functions does: the expression between `{%` and `%}`, with `$states`
 * bound and `$parse` (a Step Functions addition to JSONata) registered.
 */
export async function evaluateJsonata(field: string, states: Record<string, unknown>): Promise<any> {
  const match = /^\{%([\s\S]*)%\}$/.exec(field);
  if (match === null) {
    throw new Error(`Not a JSONata field: ${field}`);
  }
  const expression = jsonata(match[1]);
  expression.registerFunction('parse', (text: string) => JSON.parse(text));
  return expression.evaluate({}, { states });
}

/**
 * The environment a build task sends to CodeBuild, by variable name. Every
 * `$states.input.<path>` the expression reads is given the value `$.<path>`,
 * so a test can assert which input field each variable carries; the map at
 * `parametersPath` (when given) is the phase's resolved parameter set.
 */
export async function buildEnvironment(
  task: any,
  parameters?: { readonly path: string; readonly values: Record<string, string> },
): Promise<Record<string, string>> {
  const field: string = task.Arguments.EnvironmentVariablesOverride;
  const input: Record<string, any> = {};
  const set = (path: string, value: unknown) => {
    const keys = path.split('.');
    let node = input;
    for (const key of keys.slice(0, -1)) {
      node[key] = node[key] ?? {};
      node = node[key];
    }
    node[keys[keys.length - 1]] = value;
  };
  for (const [, path] of field.matchAll(/\$states\.input\.([A-Za-z0-9_.]+)/g)) {
    set(path, `$.${path}`);
  }
  // A parameter map left at its sentinel string would be iterated as a
  // value; with none given, every phase has an empty set.
  for (const [, path] of field.matchAll(/\$each\(\$states\.input\.([A-Za-z0-9_.]+)/g)) {
    set(path, {});
  }
  if (parameters !== undefined) {
    set(parameters.path.replace(/^\$\./, ''), parameters.values);
  }
  const variables: { Name: string; Type: string; Value: string }[] = await evaluateJsonata(field, { input });
  for (const variable of variables) {
    expect(variable.Type).toBe('PLAINTEXT');
  }
  return Object.fromEntries(variables.map((v) => [v.Name, v.Value]));
}
