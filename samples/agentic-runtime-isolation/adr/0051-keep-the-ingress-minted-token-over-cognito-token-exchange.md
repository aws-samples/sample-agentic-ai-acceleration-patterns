<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0051: Keep the ingress-minted transaction token over Cognito token exchange

- Status: Accepted
- Date: 2026-11-17
- Amends: ADR-0030, ADR-0031
- Deciders: Dave Roberts (PSA)

## Context
ADR-0030 and ADR-0031 rest in part on Cognito having no token-exchange grant, and ADR-0031 says to revisit if it gains one. Amazon Cognito user pools offer OAuth 2.0 Token Exchange (RFC 8693) through `GetDerivedToken` and the `/oauth2/token` token-exchange grant, on the Essentials or Plus feature plan ([developer guide](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-token-exchange.html)). The issued token is bound to one audience (a registered resource server), carries no refresh token, and can name the caller in an `act` claim when an actor token is presented. Its scopes are the intersection of the requested scopes, the subject token's scopes and the app client's scopes. The pre token generation trigger runs for the exchange (`TokenGeneration_TokenExchange`) and can add claims, but cannot add scopes.

## Options considered
### Option 1: Narrow the identity token with Cognito token exchange
The ingress, or the client, exchanges the identity token for one scoped to the agent's audience. Pros: the issuer stays the identity provider; the `act` claim and audience binding come built in; no signing key to own. Cons: the exchange can only keep scopes the identity token already holds, so every tool must first be a Cognito scope on the user's token, with the 50-scopes-per-client and pool-wide scope-name limits of ADR-0030; the grant would come from the identity provider, not from the entitlement store; it needs the Essentials or Plus plan on the consumer's pool.

### Option 2: Keep minting the transaction token at the ingress
Pros: the grant comes from the entitlement store (ADR-0030), so a tool is held without an identity-provider write and with no size cap beyond the Runtime header (ADR-0045); the issuer is the ingress only (ADR-0037). Cons: the ingress owns a KMS signing key and an issuer endpoint.

## Decision
Option 2. Cognito token exchange narrows what the identity token already says, and the identity token in this design says nothing about agents or tools. The reason ADR-0031 gave for rejecting an exchange at the identity provider now reads "it would not know the agent's tools", without the missing grant.

## Consequences
No code changes. The quota table in `architecture.md` ("Where scopes stop") lists token exchange with its scope rule. Revisit if Cognito token exchange can add claims-derived grants that a relying party may trust as entitlement, or if a consumer's identity provider can mint per-agent grants itself (ADR-0030).
