<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0031: Mint a transaction token at the ingress; the identity token never leaves it

- Status: Accepted
- Date: 2026-11-02
- Supersedes: ADR-0006, ADR-0007
- Amended by: ADR-0040
- Deciders: Dave Roberts (PSA)

## Context
ADR-0006 forwards the tenant user's identity token to the agent on opt-in, and ADR-0007 narrows it by making the client trade its refresh token for a smaller one first. Neither works for tools. Only the client holds the refresh token, so the agent and the tools gateway cannot narrow for the next hop, and the identity token they would forward carries everything the user holds. With entitlements in an ingress-owned store (ADR-0030), the grant is computed at the ingress and must reach the agent and the tools gateway in a form they can verify.

The direction in the standards is least privilege per hop. The IETF Transaction Tokens draft ([draft-ietf-oauth-transaction-tokens-09](https://datatracker.ietf.org/doc/draft-ietf-oauth-transaction-tokens/09/)) has a trusted service mint a short-lived, call-chain token from the external one. RFC 8693 ([token exchange](https://www.rfc-editor.org/rfc/rfc8693)) names the acting party in an `act` claim, and RFC 8707 ([resource indicators](https://www.rfc-editor.org/rfc/rfc8707)) binds a token to its audience. Internal Amazon guidance says the same in three rules: request a strict subset, have the downstream check `act`, and give each agent a unique `aud`.

## Options considered
### Option 1: Keep client narrowing (ADR-0007)
Pros: no new issuer. Cons: needs the refresh token at every hop that narrows; the agent and gateway never hold it; the token still names the identity provider's scopes, which no longer carry entitlement (ADR-0030).

### Option 2: RFC 8693 exchange at the identity provider
Pros: the standard shape; the issuer stays the identity provider. Cons: Cognito has no token-exchange grant, so tenant-identity would have to build one, and it would still not know the agent's tools.

### Option 3: Admin re-issue through Cognito custom authentication
A Lambda signs the user in again with a narrower scope set. Pros: the token is still a Cognito token. Cons: a function that can sign in as any user is an impersonation power held in one place; custom auth returns refresh tokens too; still bound by the scope caps of ADR-0030.

### Option 4: The ingress mints a short token with a KMS asymmetric key
Claims: `iss` (the ingress), `sub`, `tenant_id`, `agent`, `scope` = the granted set (ADR-0032), `aud` = [`agent:<name>`, `tools-gateway`], `act` = `{ sub: <ingress role> }`, `txn`, `jti`, `iat`, `exp` (300 s, ADR-0036). No refresh token; the identity token is never embedded. The ingress publishes JWKS and OIDC discovery (ADR-0037) and caches a token per (tenant, `sub`, agent, `tenant.version`) for its life. Pros: the grant is what the store says, per agent, per hop; any OIDC verifier can check it. Cons: the ingress becomes an issuer to run, rotate and audit.

## Decision
Option 4. The identity token stops at the ingress; the agent receives the transaction token in `X-Amzn-Bedrock-AgentCore-Runtime-Custom-Transaction-Token` and presents it as the bearer token on the tools path. That is a deliberate divergence from the IETF draft, which carries the token in its own header: AgentCore Gateway's `CUSTOM_JWT` authoriser reads only `Authorization`.

## Consequences
Easier: the agent holds a token it can use and no more; a stolen one is good for one agent, the tools gateway, and five minutes. Harder: the ingress is now a signer, a new trust. The key lives in KMS with no export, and an alarm watches the `Sign` rate. Verifiers accept two issuers, each in one place only: the identity token at the ingress, the transaction token at the tools gateway and the tools. The ingress MUST refuse its own token presented as an identity token, or a transaction token could be replayed as a fresh sign-in. The `delegation.*` props are removed (breaking), and with them the user-token header. KMS `Sign` scales one to one with token-cache misses, so its Region quota is named in the README. Follow-up: threat-model entries for the signer and for issuer confusion; a unit test that the ingress refuses its own `iss`. Revisit if Cognito gains token exchange, or the Gateway authoriser can read a second header.

**2026-11-02.** Amended by ADR-0040: `sub` is `<tenant_id>#<sub>` and a `user` claim carries the identity provider's `sub`; a refused token is 403 at the Gateway.

**2026-11-04.** Amended by the red team: on `api-gateway` the integration function verifies the token the authoriser forwarded (JWKS, `typ`, `iss`, `exp`, tenant and agent) before it trusts the Allow context, because an in-account principal with `lambda:InvokeFunction` can hand the function a hand-written context (T-102, M-82).

**2026-11-09.** Amended by ADR-0048 (Proposed): the ingress accepts its own token as the bearer on `POST /{backend}/delegations` only, re-issuing it for the next agent with the caller pushed onto `act`; `/invocations` still refuses it.
