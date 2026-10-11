# ADR-0011: Resolve workflow inputs before execution and update records by field ownership

**Status:** Accepted

**Context:** The service already reads or creates the tenant record before a
lifecycle transition, but the workflow rereads that mutable record to resolve
the CodeBuild source and script. That duplicate read introduces a
missing-item `States.Runtime` path and expands one build into three branches.
Separately, service read-modify-write `PutItem` calls can overwrite terminal
workflow fields, while lifecycle writes can overwrite concurrent metadata
edits.

**Decision:** The service resolves the operation-specific source, script, and
failure status into the Step Functions execution input. The workflow has one
CodeBuild task, one failure path, and a success choice only for delete versus
active. After initial tenant creation, the service and workflow use DynamoDB
`UpdateItem` expressions to modify only the fields each operation owns.
`StartExecution` rejection is conditionally compensated from the transitional
status to the matching `*_FAILED` status.

**Consequences:** The workflow no longer depends on a second tenant read or a
dynamic script-map lookup. Metadata changes cannot revert status or remove
`lastBuildId`; lifecycle transitions cannot restore stale metadata. Execution
history contains the resolved source and script path, which is acceptable for
operator-visible control-plane data. The service must keep workflow input
construction and lifecycle status mapping together, and compensation itself
remains a best-effort DynamoDB write whose failure is surfaced with the
original start failure.
