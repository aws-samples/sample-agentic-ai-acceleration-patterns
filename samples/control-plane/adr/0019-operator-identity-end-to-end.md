# ADR-0019: Operator identity flows end-to-end — access logs to build environment (threat model M12)

**Status:** Accepted (2026-09-15)

**Context:** The threat model found two attribution gaps: API Gateway
access logs used `jsonWithStandardFields()`, which omits the authorizer's
`principalId`, so destructive operations were not attributable to an
operator (T9); and application-plane changes made by provisioning scripts
attributed only to the shared fleet CodeBuild roles, with no link back to
the initiating API call (T10).

**Decision:** Thread the verified JWT `sub` through the whole chain. (1)
The API stage uses a custom JSON access-log format including
`$context.authorizer.principalId` — present on Allow AND Deny, so probing
with a valid-but-denied token is also attributable. (2) The service adds
`operatorId` (from `CallerContext`) to the resolved workflow execution
input for all five workflow-starting operations, and the state machine
forwards it to both CodeBuild projects as the `OPERATOR_ID` environment
variable. The Smithy API contract is unchanged — this is internal plumbing
from authorizer context to build environment, preserving the ADR-011
resolved-input discipline.

**Consequences:** Any fleet change now correlates access-log entry
(operator, method, path) → Step Functions execution input (`operatorId`) →
build environment (`OPERATOR_ID`), and provisioning scripts can stamp the
operator into what they provision. `operatorId` is always present in
execution input (empty string never occurs — the authorizer guarantees a
non-empty `sub`). CloudTrail data events remain a deployment-side option;
the sample provides the identity propagation they would correlate with.
