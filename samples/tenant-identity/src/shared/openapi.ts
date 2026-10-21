// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Merge the three Smithy-generated OpenAPI documents (platform, tenant,
 * token) into the one definition the single REST API is built from
 * (R-1), and patch the PLACEHOLDER integration/authoriser URIs at synth
 * time. Pure functions, unit tested: the stack reads the files, calls
 * these, and hands the result to `SpecRestApi`.
 *
 * Each generated document carries a top-level `security` and
 * `x-amazon-apigateway-request-validator`. REST API applies those at the
 * operation level, so a single merged document with three different
 * defaults would be ambiguous. `mergeOpenApi` therefore pushes each
 * document's defaults DOWN onto its own operations before the union, unless
 * the operation already states its own (the token operation carries
 * `security: []` and its own `params-only` validator).
 */

/** A path prefix → Lambda function ARN map for `patchIntegrations`. */
export interface IntegrationMapping {
  /** Routes under `/platform` → the platform function. */
  readonly platformFnArn: string;
  /** Routes under `/tenant` → the tenant-users function. */
  readonly tenantFnArn: string;
  /** Routes under `/oauth2` → the token-exchange function. */
  readonly tokenFnArn: string;
  /** The tenant authoriser function (the `PLACEHOLDER` authoriserUri). */
  readonly authorizerFnArn: string;
  /** Partition, e.g. `aws`. */
  readonly partition: string;
  /** Region the API is deployed in. */
  readonly region: string;
}

type Json = Record<string, any>;

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'] as const;

const SECURITY_KEY = 'security';
const VALIDATOR_KEY = 'x-amazon-apigateway-request-validator';
const VALIDATORS_KEY = 'x-amazon-apigateway-request-validators';
const BINARY_KEY = 'x-amazon-apigateway-binary-media-types';

/**
 * Merge the generated OpenAPI documents into one. Throws on a duplicate
 * `path + method`, or on two schemas of the same name with different
 * content — a merge that silently dropped either would ship a wrong API.
 */
export function mergeOpenApi(docs: object[]): object {
  if (docs.length === 0) {
    throw new Error('mergeOpenApi: no documents to merge');
  }
  const first = docs[0] as Json;
  const merged: Json = {
    openapi: first.openapi,
    info: first.info,
    paths: {},
    components: { schemas: {}, securitySchemes: {} },
  };

  const binaryMediaTypes = new Set<string>();
  const requestValidators: Json = {};

  for (const raw of docs as Json[]) {
    const doc = pushDefaultsOntoOperations(raw);

    // --- paths: union, reject duplicate path+method ----------------------
    for (const [pathKey, pathItem] of Object.entries(doc.paths ?? {})) {
      const existing = (merged.paths[pathKey] ??= {});
      for (const [method, operation] of Object.entries(pathItem as Json)) {
        if (isHttpMethod(method) && existing[method] !== undefined) {
          throw new Error(`mergeOpenApi: duplicate operation ${method.toUpperCase()} ${pathKey}`);
        }
        existing[method] = operation;
      }
    }

    // --- components.schemas: union, reject conflicting definitions -------
    for (const [name, schema] of Object.entries(doc.components?.schemas ?? {})) {
      const existing = merged.components.schemas[name];
      if (existing !== undefined && !deepEqual(existing, schema)) {
        throw new Error(`mergeOpenApi: schema '${name}' defined differently in two documents`);
      }
      merged.components.schemas[name] = schema;
    }

    // --- components.securitySchemes: union -------------------------------
    for (const [name, scheme] of Object.entries(doc.components?.securitySchemes ?? {})) {
      const existing = merged.components.securitySchemes[name];
      if (existing !== undefined && !deepEqual(existing, scheme)) {
        throw new Error(`mergeOpenApi: securityScheme '${name}' defined differently in two documents`);
      }
      merged.components.securitySchemes[name] = scheme;
    }

    // --- binary media types + request validators: union -----------------
    for (const media of (doc[BINARY_KEY] as string[] | undefined) ?? []) {
      binaryMediaTypes.add(media);
    }
    for (const [name, validator] of Object.entries(doc[VALIDATORS_KEY] ?? {})) {
      const existing = requestValidators[name];
      if (existing !== undefined && !deepEqual(existing, validator)) {
        throw new Error(`mergeOpenApi: request validator '${name}' defined differently in two documents`);
      }
      requestValidators[name] = validator;
    }
  }

  if (binaryMediaTypes.size > 0) {
    merged[BINARY_KEY] = [...binaryMediaTypes].sort();
  }
  if (Object.keys(requestValidators).length > 0) {
    merged[VALIDATORS_KEY] = requestValidators;
  }

  return merged;
}

/**
 * Returns a deep copy of `doc` with its top-level `security` and
 * `x-amazon-apigateway-request-validator` moved onto each operation that
 * does not already declare its own. The top-level keys are then dropped so
 * the merged document has no ambiguous global default.
 */
function pushDefaultsOntoOperations(doc: Json): Json {
  const copy: Json = deepCopy(doc);
  const defaultSecurity = copy[SECURITY_KEY];
  const defaultValidator = copy[VALIDATOR_KEY];

  for (const pathItem of Object.values(copy.paths ?? {}) as Json[]) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!isHttpMethod(method)) {
        continue;
      }
      const op = operation as Json;
      if (defaultSecurity !== undefined && op[SECURITY_KEY] === undefined) {
        op[SECURITY_KEY] = defaultSecurity;
      }
      if (defaultValidator !== undefined && op[VALIDATOR_KEY] === undefined) {
        op[VALIDATOR_KEY] = defaultValidator;
      }
    }
  }

  delete copy[SECURITY_KEY];
  delete copy[VALIDATOR_KEY];
  return copy;
}

/**
 * Replace every `PLACEHOLDER` integration URI with the Lambda invocation
 * URI for the function that serves that path prefix, and the authoriser's
 * `PLACEHOLDER` authoriserUri with the authoriser function. Returns a deep
 * copy; the input is untouched. Throws if any PLACEHOLDER survives, so a
 * mis-prefixed route fails synth rather than deploying a broken API.
 */
export function patchIntegrations(doc: object, mapping: IntegrationMapping): object {
  const copy: Json = deepCopy(doc as Json);

  const invocationUri = (fnArn: string) =>
    `arn:${mapping.partition}:apigateway:${mapping.region}:lambda:path/2015-03-31/functions/${fnArn}/invocations`;

  const fnArnForPath = (pathKey: string): string => {
    if (pathKey.startsWith('/platform')) {
      return mapping.platformFnArn;
    }
    if (pathKey.startsWith('/tenant')) {
      return mapping.tenantFnArn;
    }
    if (pathKey.startsWith('/oauth2')) {
      return mapping.tokenFnArn;
    }
    throw new Error(`patchIntegrations: no function mapped for path '${pathKey}'`);
  };

  // Authoriser URI(s).
  for (const scheme of Object.values(copy.components?.securitySchemes ?? {}) as Json[]) {
    const authorizer = scheme['x-amazon-apigateway-authorizer'];
    if (authorizer?.authorizerUri === 'PLACEHOLDER') {
      authorizer.authorizerUri = invocationUri(mapping.authorizerFnArn);
    }
  }

  // Integration URIs, by path prefix.
  for (const [pathKey, pathItem] of Object.entries(copy.paths ?? {})) {
    const fnArn = fnArnForPath(pathKey);
    for (const [method, operation] of Object.entries(pathItem as Json)) {
      if (!isHttpMethod(method)) {
        continue;
      }
      const integration = (operation as Json)['x-amazon-apigateway-integration'];
      if (integration?.uri === 'PLACEHOLDER') {
        integration.uri = invocationUri(fnArn);
      }
    }
  }

  if (JSON.stringify(copy).includes('PLACEHOLDER')) {
    throw new Error('patchIntegrations: a PLACEHOLDER URI was not replaced');
  }
  return copy;
}

function isHttpMethod(key: string): boolean {
  return (HTTP_METHODS as readonly string[]).includes(key);
}

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
