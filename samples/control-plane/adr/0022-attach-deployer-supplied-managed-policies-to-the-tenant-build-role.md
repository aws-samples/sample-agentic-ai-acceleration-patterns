# ADR-0022: Attach deployer-supplied managed policies to the tenant build role

- Status: Proposed
- Date: 2026-10-26
- Deciders: Dave Roberts (SA)

## Context
A tenant script may need to call an application-plane API: the tenant-identity mount calls its platform API with SigV4 ([control-plane mounting spec](../../tenant-identity/design/control-plane-mounting.spec.md)). The tenant build role grants only the SSM namespaces of spec §6.2. P-3 forbids application-plane configuration in the control plane, so the grant cannot be identity-shaped.

## Options considered
### Option 1: Generic `tenantBuildManagedPolicyArns` context, attached at synth
Producer-owned least privilege (tenant-identity ADR-0030); the control plane learns an ARN list, not what it means. Synth validates each entry is a managed-policy ARN in this account and partition.

### Option 2: Export the tenant build role ARN; the deployer attaches policies out of band
No new input. Con: drift outside CloudFormation, and the grant outlives a redeploy unpredictably.

### Option 3: A typed identity input (API URL and routes)
Explicit. Con: the identity-shaped input ADR-004 removed.

## Decision
Option 1. Generic, reviewable in the deploy command, and torn down with the stack.

## Consequences
The reach of the build role becomes deployer-defined; the blast-radius bound of ADR-021 now includes whatever is attached, and the README must say so. A cell-build variant can follow if a cell script needs one.
