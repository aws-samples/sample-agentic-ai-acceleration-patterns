<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0037: Publish the ingress as an OIDC issuer: JWKS and discovery on the ingress, keys in KMS with `kid` rotation

- Status: Accepted
- Date: 2026-11-02
- Amended by: ADR-0046
- Deciders: Dave Roberts (PSA)

## Context
The Gateway's `CUSTOM_JWT` authoriser and the tools verify the transaction token (ADR-0031) through an OIDC discovery URL, so the ingress must publish one, with a JWKS of its public keys. Keys must rotate without refusing tokens still in flight. The `agentcore-gateway` ingress has no HTTP route of its own to serve them from.

## Options considered
### Option 1: A static JWKS in Amazon S3 behind Amazon CloudFront
Pros: no compute; cacheable at the edge. Cons: a second public origin to secure; a deploy step must copy the public key on every rotation; a stale copy refuses every new token.

### Option 2: Two GET routes on the ingress, served by a small Lambda
`/.well-known/openid-configuration` and `/.well-known/jwks.json` on the API Gateway ingress, unauthenticated and cached, served by a Lambda that reads `GetPublicKey`. On the `agentcore-gateway` ingress a minimal API Gateway carries these two routes only. Pros: the published key is read from KMS, so it cannot drift; the issuer URL is the ingress the deployer already has. Cons: a new public route; one more API Gateway on the `agentcore-gateway` path.

### Option 3: Cognito as the issuer
Pros: no new issuer. Cons: Cognito cannot mint a token with our claims (ADR-0031), so it cannot be the issuer of a token the ingress signs.

## Decision
Option 2. The signing key is a KMS asymmetric `SIGN_VERIFY` key; `kid` is the KMS key id. The key, the two routes and the `grantSign(grantee)` method ship as the `TokenSigner` construct, created by `SharedIngress` and exported for a consumer that builds its own ingress. During rotation a second key is created and listed in JWKS, new tokens are signed with it, and the old key stays listed until the last token signed with it has expired (`ttl`, ADR-0036).

## Consequences
Easier: verifiers need only the discovery URL; rotation is a key swap with no verifier redeploy. Harder: a new public, anonymous route on the ingress. Under `builder-security` it may serve anonymous content only, and a JWKS is public by design; the routes take no input and set cache headers. `kms:Sign` is granted to the mint role only and `kms:GetPublicKey` to the JWKS Lambda only. Follow-up: a test that the routes answer without a token and expose nothing but the discovery document and the keys; a rotation runbook; an alarm on `Sign` errors. Revisit if the Gateway can take a JWKS inline, or the `agentcore-gateway` ingress gains a route of its own.

Amended by: ADR-0046
