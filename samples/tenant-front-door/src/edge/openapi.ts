// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The registrar's REST API definition (spec §5.1): the OpenAPI document
 * `smithy build` generates from `model/`, with the `PLACEHOLDER`
 * integration URIs pointed at the registrar function. Never hand-written;
 * the same approach as `tenant-identity`'s `src/shared/openapi.ts`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

type Json = Record<string, any>;

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];
const VALIDATOR_KEY = 'x-amazon-apigateway-request-validator';
const VALIDATORS_KEY = 'x-amazon-apigateway-request-validators';
const PARAMS_ONLY_VALIDATOR = 'params-only';

/** Where `smithy build` writes the document (`smithy-build.json`). */
export const REGISTRAR_OPENAPI = path.join(__dirname, '..', 'smithy', 'source', 'openapi', 'RegistrarService.openapi.json');

export function readRegistrarOpenApi(file: string = REGISTRAR_OPENAPI): object {
  if (!fs.existsSync(file)) {
    throw new Error(`${file} is missing: run \`smithy build\` (the pre-compile step of \`npx projen build\`)`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Returns a copy of `doc` with every `PLACEHOLDER` integration URI set to
 * the Lambda invocation URI of `functionArn`. Throws when one is left, so a
 * new operation without an integration fails synth.
 */
export function patchIntegrations(doc: object, invocationUri: string): object {
  const copy: Json = JSON.parse(JSON.stringify(doc));
  for (const op of operations(copy)) {
    const integration = op['x-amazon-apigateway-integration'];
    if (integration?.uri === 'PLACEHOLDER') {
      integration.uri = invocationUri;
    }
  }
  if (JSON.stringify(copy).includes('PLACEHOLDER')) {
    throw new Error('patchIntegrations: a PLACEHOLDER URI was not replaced');
  }
  return copy;
}

/**
 * Lets an operation whose body has no required member be called without a
 * body. API Gateway's `full` validator refuses an empty body whenever a
 * model is attached (`tenant-identity` ADR-0034), and the route hook's
 * `PutTenantRoute` carries no `customDomain`. Such operations move to a
 * parameters-only validator; the registrar's server SDK still validates a
 * body that is present. Returns a copy.
 */
export function allowEmptyBody(doc: object): object {
  const copy: Json = JSON.parse(JSON.stringify(doc));
  const validators: Json = (copy[VALIDATORS_KEY] ??= {});
  validators[PARAMS_ONLY_VALIDATOR] ??= { validateRequestParameters: true, validateRequestBody: false };
  for (const op of operations(copy)) {
    const ref: string | undefined = op.requestBody?.content?.['application/json']?.schema?.$ref;
    if (ref === undefined) continue;
    const schema: Json | undefined = copy.components?.schemas?.[ref.replace('#/components/schemas/', '')];
    if (schema !== undefined && (schema.required ?? []).length === 0) {
      op[VALIDATOR_KEY] = PARAMS_ONLY_VALIDATOR;
    }
  }
  return copy;
}

function operations(doc: Json): Json[] {
  const ops: Json[] = [];
  for (const item of Object.values(doc.paths ?? {}) as Json[]) {
    for (const [method, op] of Object.entries(item)) {
      if (HTTP_METHODS.includes(method)) ops.push(op as Json);
    }
  }
  return ops;
}
