<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0007: Downscope by requiring a narrowed bearer token, not by exchanging at ingress

- Status: Accepted
- Date: 2026-10-26
- Deciders: Dave Roberts (PSA)

## Context
Downscoping is optional. Cognito narrows only from a refresh token (tenant-identity ADR-0009); the ingress sees only the access token, so it cannot narrow on its own.

## Options considered
### Option 1: Ingress calls tenant-identity `/oauth2/token`
Cons: needs the user's refresh token at ingress, a far more powerful credential than the one being protected.
### Option 2: Client narrows first; ingress enforces `scope ⊆ allowedScopes` and refuses `aws.cognito.signin.user.admin`
Pros: the forwarded token is the narrowed one; the ingress enforces the rule rather than trusting the client. Cons: the client does one extra call per conversation.
### Option 3: Mint a passport JWT at ingress
Pros: full control of claims. Cons: a new issuer to run and audit; out of scope (§1.2).

## Decision
Option 2, only valid with `forwardUserToken`.

## Consequences
Easier: no new issuer. Harder: clients must know the exchange; the README shows the call. Revisit with an IdP that supports RFC 8693 on access tokens, or a passport-token sample.
