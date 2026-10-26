# ADR-0033: Encrypt the parked admin password with a key the build role cannot decrypt

- Status: Proposed
- Date: 2026-10-26
- Deciders: Dave Roberts (SA)

## Context
ADR-0031 parks the first admin's temporary password in an SSM SecureString under `/application-plane/tenants/<T>/identity/`. With the default SSM key, anything that can read that path can decrypt it. In control-plane that is the shared tenant build role, which runs every tenant's script (control-plane ADR-021). ADR-0031 listed a customer-managed key as a hardening item; the blind review asked whether to pull it forward, and the answer is yes.

## Options considered
### Option 1: This stack owns a symmetric KMS key; the build role gets `kms:Encrypt` through SSM only
The key is published beside the other shared identity parameters (ADR-0017). The `PlatformInvokePolicy` (ADR-0030) gains `kms:Encrypt` and `kms:GenerateDataKey` on the key with `kms:ViaService = ssm`. Nobody gets `kms:Decrypt` unless the deployer grants it. Con: one key per account and Region (about $1/month) and one more shared parameter.

### Option 2: control-plane owns the key
The consumer would create a key for a secret it knows nothing about, which breaks its P-3 (no identity-shaped resources) and inverts the dependency the same way ADR-0030 option 3 did.

### Option 3: Keep the default SSM key
No cost, no parameter. Con: the blast radius of the shared build role includes every tenant's first-admin password until it is collected.

## Decision
Option 1 (mounting spec §6.5, M-R-11). The producer owns the secret's key as it owns the secret's policy (M-P-4); the consumer attaches one managed policy and learns nothing new. The key policy stays the account default so the deployer decides who decrypts with ordinary IAM, and the integration test proves the build role cannot (spec §10 step 5b).

## Consequences
`tenant/create.sh` must read `adminPasswordKeyArn` and pass `--key-id`; a park with the default key is refused. The vendor's reader needs `kms:Decrypt` on the key, which the README mounting section must say. Deleting the parameter needs no KMS permission. ADR-0031's hardening list loses this item; delivering the invitation by mail (its option 2) remains.
