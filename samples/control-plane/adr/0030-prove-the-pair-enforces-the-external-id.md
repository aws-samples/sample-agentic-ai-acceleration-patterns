# ADR-0030: Prove the pair enforces the external id with a negative probe

- Status: Accepted
- Date: 2026-11-10
- Amends: ADR-0027, ADR-0029
- Deciders: Dave Roberts (SA)

## Context
ADR-029 requires `externalId` on `PutAccount` for a tenant-owned account, and ADR-027 verifies the handshake by assuming both halves of the pair with that id. The pull request review found that the positive probe cannot tell whether the pair *requires* the id: STS evaluates `sts:ExternalId` only when the trust policy conditions on it, so an `AssumeRole` that supplies an id to a role installed without one succeeds. A customer who deployed `CellAccountStack` without `externalId` therefore registered cleanly, `GetAccount` reported `externalIdConfigured: true`, and the account had no confused-deputy guard while the spec, ADR-029 and the code comment said it had. The `aws:PrincipalArn` pin still kept every other AWS account out; the gap was the consent check among this control plane's operators.

## Options considered
### Option 1: Negative probe at registration
When `externalId` is supplied, assume each half a second time *without* it and require `AccessDenied`; a success is a refusal of its own kind ("does not require the external id"). Pros: the registration check matches the claim; four STS calls instead of two, still well inside the gateway window; no new permission (the API role already assumes both roles). Cons: two more `AssumeRole` events in the owner's CloudTrail per registration, one of them refused.

### Option 2: Read the trust policy
Call `iam:GetRole` in the target account and inspect the condition. Cons: the pair would have to grant `iam:GetRole` on itself to the control plane, widening the pair beyond §6.2 for a check STS can make for free.

### Option 3: Document the gap
Keep the positive probe and move the claim into the threat model as a residual. Cons: the sample shows the pattern AWS recommends for third-party roles; a check the docs describe and the code does not make is the worst of both.

## Decision
Option 1. `stsHandshakeProbe` runs the positive call for each half; when it succeeds and an external id was supplied, it runs the same call without the id and reports a refusal if STS admits it. The refusal names the role and tells the owner to redeploy the pair with `externalId`. The negative call carries the same deny-all session policy and 900-second duration as the positive one, so a success it does provoke yields credentials that can do nothing. The same change classifies STS errors: `AccessDenied` is a refusal (missing role, wrong principal, wrong or missing id); any other failure (throttling, network, 5xx) is `HandshakeUnavailableError`, which `PutAccount` maps to a 500 asking for a retry, instead of telling the operator to reinstall a pair that may be fine.

## Consequences
A pair installed without an id is refused at `PutAccount` whenever the operator supplies one, for vendor-owned accounts too: supplying an id is a statement that the pair enforces it, and `externalIdConfigured` is now true only when it does. The integration test adds the case by registering the home account (whose pair has no id) as tenant-owned with an id and expecting the 400. Spec §6.4 and R-26, threat model T22/M19, the README and `architecture.md` describe the two-sided probe. Revisit if STS ever exposes the trust evaluation directly; the negative call would then be redundant.
