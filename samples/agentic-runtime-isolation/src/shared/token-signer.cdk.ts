// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `TokenSigner` (spec C-13, §5.2, §6.2.3; ADR-0037): the transaction-token
 * issuer's keys and its two public routes.
 *
 * - One KMS asymmetric `SIGN_VERIFY` key per generation: `RSA_2048` for
 *   `RS256` (default) or `ECC_NIST_P256` for `ES256`. `kid` is the KMS key
 *   id. Bumping `keyGeneration` from N to N+1 creates key N+1, which signs
 *   from that deploy on; key N stays in the JWKS but may no longer sign. At
 *   N+2 key N leaves the code, CloudFormation deletes it and KMS schedules
 *   its deletion (30-day window).
 * - The key policy is written in full (P-14). `kms:Sign` is granted only in
 *   the key policy, to the one minting role, never to the account, so no
 *   IAM policy can add a signer. No grant can either: the account root holds
 *   no `kms:Create*`, and an explicit `Deny` on `kms:CreateGrant` for every
 *   principal stops a grant whatever an IAM policy says. The residual is
 *   `kms:PutKeyPolicy`, which the account root keeps so CloudFormation can
 *   update the policy on a later deploy (a new `grantSign` principal, a
 *   rotation): a principal holding it through IAM can rewrite the policy and
 *   add a signer. That is the account's key administrators, i.e. the
 *   deployer's own privilege, and every `PutKeyPolicy` is in CloudTrail.
 *   The account may delegate reads (`GetPublicKey`) through IAM only when
 *   `delegatePublicKey` is set.
 * - The JWKS is rendered at deploy by a custom resource reading
 *   `GetPublicKey` (src/shared/jwks.function.ts) and served with the OIDC
 *   discovery document from mock integrations, `Cache-Control: public,
 *   max-age=300` (spec §5.2): no Lambda and no KMS call per read.
 *
 * Created by `SharedIngress`; exported for a consumer that builds its own
 * ingress.
 */

import * as path from 'node:path';
import { CustomResource, Duration, RemovalPolicy, Stack, Validations } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { customResourceFunction } from './custom-resource.cdk';
import { type JwsAlgorithm, KMS_SIGNING_ALGORITHM } from './jws';

/** The two discovery paths under the issuer (spec §5.2). */
export const WELL_KNOWN = {
  segment: '.well-known',
  discovery: 'openid-configuration',
  jwks: 'jwks.json',
} as const;

/** `Cache-Control` of the two public routes (spec §5.2). */
export const DISCOVERY_CACHE_CONTROL = 'public, max-age=300';

/** The KMS key spec for each JOSE algorithm. */
export const KEY_SPEC: Record<JwsAlgorithm, kms.KeySpec> = {
  RS256: kms.KeySpec.RSA_2048,
  ES256: kms.KeySpec.ECC_NIST_P256,
};

/**
 * The key-policy actions the account keeps: administration only. Never
 * `kms:Sign`, and not `kms:GetPublicKey` either unless the key delegates it
 * (M-40: the public half only to the roles that render or verify). No
 * `kms:Create*` (it covers `CreateGrant`; the sample creates no alias, so
 * no create action is needed), and `kms:PutKeyPolicy` alone rather than
 * `kms:Put*`: CloudFormation needs it to update the policy on later deploys.
 */
export const KEY_ADMIN_ACTIONS = [
  'kms:Describe*',
  'kms:Enable*',
  'kms:List*',
  'kms:PutKeyPolicy',
  'kms:Update*',
  'kms:Revoke*',
  'kms:Disable*',
  'kms:GetKeyPolicy',
  'kms:GetKeyRotationStatus',
  'kms:Delete*',
  'kms:TagResource',
  'kms:UntagResource',
  'kms:ScheduleKeyDeletion',
  'kms:CancelKeyDeletion',
];

export interface TokenSignerProps {
  /** Default `'RS256'`. */
  readonly algorithm?: JwsAlgorithm;
  /** Default 1; bump to rotate (spec §6.2.3). */
  readonly keyGeneration?: number;
  /** The one role allowed `kms:Sign` on the current key (the authoriser or the interceptor). */
  readonly signer: iam.IRole;
}

/** An asymmetric signing key with a key policy that never grants the account `kms:Sign` and denies `kms:CreateGrant` to everyone. */
export function signingKey(
  scope: Construct,
  id: string,
  spec: kms.KeySpec,
  description: string,
  options: { readonly delegatePublicKey?: boolean } = {},
): kms.Key {
  const key = new kms.Key(scope, id, {
    description,
    keySpec: spec,
    keyUsage: kms.KeyUsage.SIGN_VERIFY,
    removalPolicy: RemovalPolicy.DESTROY, // sample only; KMS still waits the pending window
    pendingWindow: Duration.days(30),
    policy: new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          sid: 'KeyAdministration',
          principals: [new iam.AccountRootPrincipal()],
          actions: options.delegatePublicKey === true ? [...KEY_ADMIN_ACTIONS, 'kms:GetPublicKey'] : KEY_ADMIN_ACTIONS,
          resources: ['*'],
        }),
        // No grant on a signing key, for anyone: a grant is the one path to
        // `kms:Sign` that bypasses the key policy's named principals.
        new iam.PolicyStatement({
          sid: 'DenyGrants',
          effect: iam.Effect.DENY,
          principals: [new iam.AnyPrincipal()],
          actions: ['kms:CreateGrant'],
          resources: ['*'],
        }),
      ],
    }),
  });
  Validations.of(key).acknowledge({
    id: 'AwsSolutions-KMS5',
    reason: 'An asymmetric SIGN_VERIFY key cannot rotate automatically; rotation is a new key per keyGeneration, with the previous key kept in the JWKS (ADR-0037).',
  });
  return key;
}

export class TokenSigner extends Construct {
  readonly algorithm: JwsAlgorithm;
  readonly keyGeneration: number;
  /** The key that signs from this deploy on. */
  readonly currentKey: kms.Key;
  /** The previous generation's key, still in the JWKS, no longer allowed to sign; undefined at generation 1. */
  readonly previousKey?: kms.Key;
  /** The JWKS document (a deploy-time token). */
  readonly jwks: string;

  private signGrants = 0;

  constructor(scope: Construct, id: string, props: TokenSignerProps) {
    super(scope, id);
    const algorithm = props.algorithm ?? 'RS256';
    const generation = props.keyGeneration ?? 1;
    if (algorithm !== 'RS256' && algorithm !== 'ES256') {
      throw new Error(`TokenSigner: algorithm must be 'RS256' or 'ES256' (got ${String(algorithm)})`);
    }
    if (!Number.isInteger(generation) || generation < 1) {
      throw new Error(`TokenSigner: keyGeneration must be a positive integer (got ${String(generation)})`);
    }
    this.algorithm = algorithm;
    this.keyGeneration = generation;
    const spec = KEY_SPEC[algorithm];
    // The logical id carries the generation, so a bump is a new key and the
    // key two generations back leaves the template (spec §6.2.3).
    this.currentKey = signingKey(this, `SigningKey${generation}`, spec, `runtime-isolation transaction-token signing key, generation ${generation} (ADR-0037)`);
    if (generation > 1) {
      this.previousKey = signingKey(this, `SigningKey${generation - 1}`, spec, `runtime-isolation transaction-token signing key, generation ${generation - 1} (ADR-0037)`);
    }
    this.grantSign(props.signer);

    const fn = customResourceFunction(
      this,
      'JwksFunction',
      path.join(__dirname, 'jwks.function.ts'),
      'runtime-isolation: renders the transaction-token JWKS from KMS GetPublicKey at deploy (ADR-0037)',
    );
    const keys = [this.currentKey, ...(this.previousKey !== undefined ? [this.previousKey] : [])];
    // M-40: the public half goes to the JWKS renderer through the key policy, by name.
    for (const key of keys) {
      key.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'RenderJwks',
          principals: [fn.grantPrincipal],
          actions: ['kms:GetPublicKey'],
          resources: ['*'],
        }),
      );
    }
    const resource = new CustomResource(this, 'Jwks', {
      serviceToken: fn.functionArn,
      resourceType: 'Custom::RuntimeIsolationJwks',
      properties: { KeyIds: keys.map((k) => k.keyId) },
    });
    this.jwks = resource.getAttString('Jwks');
  }

  /** The current key's id: the `kid` of every token minted from this deploy on. */
  get keyId(): string {
    return this.currentKey.keyId;
  }

  /**
   * Allows `grantee` to sign with the current key, in the key policy, and
   * only with this algorithm. `SharedIngress` grants its minting role; the
   * integration stacks may grant a test mint (spec §3.3).
   */
  grantSign(grantee: iam.IGrantable): void {
    this.currentKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: `SignTransactionTokens${++this.signGrants}`,
        principals: [grantee.grantPrincipal],
        actions: ['kms:Sign'],
        resources: ['*'],
        conditions: { StringEquals: { 'kms:SigningAlgorithm': KMS_SIGNING_ALGORITHM[this.algorithm] } },
      }),
    );
  }

  /**
   * Adds `GET /.well-known/openid-configuration` and `GET /.well-known/jwks.json`
   * under `api.root`, unauthenticated, answered by mock integrations
   * (spec §5.2). `issuer` is `<baseUrl>`, the stage URL of `api`.
   */
  addDiscoveryRoutes(api: apigateway.RestApi, issuer: string): void {
    const stack = Stack.of(this);
    const discovery = stack.toJsonString({
      issuer,
      jwks_uri: `${issuer}/${WELL_KNOWN.segment}/${WELL_KNOWN.jwks}`,
      id_token_signing_alg_values_supported: [this.algorithm],
      response_types_supported: ['token'],
      subject_types_supported: ['public'],
    });
    const wellKnown = api.root.addResource(WELL_KNOWN.segment);
    const route = (name: string, body: string) => {
      const method = wellKnown.addResource(name).addMethod(
        'GET',
        new apigateway.MockIntegration({
          requestTemplates: { 'application/json': '{"statusCode": 200}' },
          passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
          integrationResponses: [
            {
              statusCode: '200',
              responseTemplates: { 'application/json': body },
              responseParameters: {
                'method.response.header.Cache-Control': `'${DISCOVERY_CACHE_CONTROL}'`,
                'method.response.header.Content-Type': "'application/json'",
              },
            },
          ],
        }),
        {
          authorizationType: apigateway.AuthorizationType.NONE,
          methodResponses: [
            {
              statusCode: '200',
              responseParameters: { 'method.response.header.Cache-Control': true, 'method.response.header.Content-Type': true },
            },
          ],
        },
      );
      const reason =
        'The OIDC discovery document and the JWKS are public by design: relying parties (the tools gateway CUSTOM_JWT authoriser, AgentCore Identity) fetch them unauthenticated; they hold public keys only (ADR-0037).';
      Validations.of(method).acknowledge({ id: 'AwsSolutions-APIG4', reason });
      Validations.of(method).acknowledge({ id: 'AwsSolutions-COG4', reason });
    };
    route(WELL_KNOWN.discovery, discovery);
    route(WELL_KNOWN.jwks, this.jwks);
    // A rotation changes the JWKS behind the same template token, so the
    // deployment's hash must change with the generation (spec §6.2.3).
    api.latestDeployment?.addToLogicalId({ keyGeneration: this.keyGeneration, algorithm: this.algorithm });
  }
}
