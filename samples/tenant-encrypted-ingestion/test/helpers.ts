// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Test helpers. A synthetic issuer (one RS256 key pair, a local JWKS, a
 * token minter), synthesis of the construct in a bare stack, and template
 * lookups. Nothing here touches the network; every identifier is invented
 * (account 111122223333, tenants `tenant-a`, `tenant-b`).
 */

import { App, Duration, Stack, Validations } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { AwsSolutionsChecks } from 'cdk-nag';
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload, type JWTVerifyGetKey, type KeyLike, SignJWT } from 'jose';
import type { Discovery } from '../src/shared/verifier';
import { TenantEncryptedIngestion, type TenantEncryptedIngestionProps } from '../src/tenant-encrypted-ingestion.cdk';
import { LambdaValidator } from '../src/validators/lambda-validator';

export const ACCOUNT = '111122223333';
export const REGION = 'eu-central-1';
export const ISSUER = 'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_TESTPOOL00';
export const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
export const CLIENT_ID = 'testclient0000000000000000';

export interface TestIssuer {
  readonly getKey: JWTVerifyGetKey;
  readonly fetchDiscovery: (url: string) => Promise<Discovery>;
  mint(overrides?: JWTPayload & { exp?: number }, remove?: string[]): Promise<string>;
  mintForeign(overrides?: JWTPayload): Promise<string>;
}

export const DEFAULT_CLAIMS: JWTPayload = {
  sub: 'user-a1',
  tenant_id: 'tenant-a',
  client_id: CLIENT_ID,
  token_use: 'access',
  scope: 'ingestion/deliver ingestion/read',
};

export async function testIssuer(): Promise<TestIssuer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const foreign = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const getKey = createLocalJWKSet({ keys: [jwk] });
  const sign = async (key: KeyLike, overrides: JWTPayload = {}, remove: string[] = []) => {
    const claims: JWTPayload = { ...DEFAULT_CLAIMS, ...overrides };
    for (const name of remove) {
      delete claims[name];
    }
    let jwt = new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuedAt();
    jwt = claims.iss === undefined ? jwt.setIssuer(ISSUER) : jwt;
    jwt = claims.exp === undefined ? jwt.setExpirationTime('5m') : jwt;
    return jwt.sign(key);
  };
  return {
    getKey,
    fetchDiscovery: async (url: string) => {
      if (url !== DISCOVERY_URL) {
        throw new Error('unexpected discovery url');
      }
      return { issuer: ISSUER, jwksUri: `${ISSUER}/.well-known/jwks.json` };
    },
    mint: (overrides, remove) => sign(privateKey, overrides, remove),
    mintForeign: (overrides) => sign(foreign.privateKey, overrides),
  };
}

export interface Synthesised {
  readonly stack: Stack;
  readonly construct: TenantEncryptedIngestion;
  readonly template: Template;
}

/** The construct in a bare stack, bundling skipped. */
export function synthConstruct(
  props: Partial<TenantEncryptedIngestionProps> | ((stack: Stack) => Partial<TenantEncryptedIngestionProps>) = {},
  withNag = false,
): Synthesised {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [], 'aws:cdk:enable-path-metadata': true } });
  if (withNag) {
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  }
  const stack = new Stack(app, 'TestStack', { env: { account: ACCOUNT, region: REGION } });
  const construct = new TenantEncryptedIngestion(stack, 'Ingestion', {
    identity: { discoveryUrl: DISCOVERY_URL, allowedClientIds: [CLIENT_ID] },
    identityApi: { apiUrl: 'https://abc123defg.execute-api.eu-central-1.amazonaws.com/v1/', platformInvokePolicyArn: `arn:aws:iam::${ACCOUNT}:policy/PlatformInvoke` },
    ...(typeof props === 'function' ? props(stack) : props),
  });
  return { stack, construct, template: Template.fromStack(stack) };
}

/** A validator over an imported function, for props. */
export function validatorFor(stack: Stack, name: string, seconds = 30): LambdaValidator {
  const fn = lambda.Function.fromFunctionArn(stack, `Fn-${name}`, `arn:aws:lambda:${REGION}:${ACCOUNT}:function:validator-${name}`);
  return new LambdaValidator(fn, { name, timeout: Duration.seconds(seconds) });
}

export function importedRole(stack: Stack, id: string, name: string): iam.IRole {
  return iam.Role.fromRoleArn(stack, id, `arn:aws:iam::${ACCOUNT}:role/${name}`, { mutable: false });
}

/** The logical id of the resource whose construct path ends with `pathSuffix`. */
export function logicalIdOf(template: Template, type: string, pathSuffix: string): string {
  const resources = template.findResources(type);
  const found = Object.entries(resources).find(([, r]) => (r.Metadata?.['aws:cdk:path'] as string | undefined)?.endsWith(pathSuffix));
  if (found === undefined) {
    throw new Error(`no ${type} at ${pathSuffix}`);
  }
  return found[0];
}

/** Every policy statement attached to the role with logical id `roleId` (inline policies). */
export function statementsOf(template: Template, roleId: string): Record<string, any>[] {
  const policies = template.findResources('AWS::IAM::Policy');
  const out: Record<string, any>[] = [];
  for (const policy of Object.values(policies)) {
    const roles = (policy.Properties.Roles ?? []) as { Ref?: string }[];
    if (roles.some((r) => r.Ref === roleId)) {
      out.push(...(policy.Properties.PolicyDocument.Statement as Record<string, any>[]));
    }
  }
  return out;
}

export function asArray<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/** Resolved JSON of a token-bearing value, as one string (for substring checks). */
export function flat(value: unknown): string {
  return JSON.stringify(value);
}
