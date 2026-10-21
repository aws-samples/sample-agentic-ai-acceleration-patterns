# ADR-0019: Delete log groups only after their writers have stopped, and leave the account's API Gateway role alone

- Status: Accepted
- Date: 2026-10-21
- Deciders: Dave Roberts (SA)

## Context
§6.2 promises that `cdk destroy` leaves nothing with the sample's prefix.
The first four integration runs on 2026-10-21 in eu-central-1 broke that
promise in three ways. CloudTrail showed the cause of each.

1. **Late log delivery.** CloudFormation deleted the API access log group
   at 13:30:50; API Gateway's service role created it again at 13:30:52
   and wrote streams until 13:31:05. The recreated group has no retention
   and belongs to no stack. Lambda behaves the same way for a function
   invoked near teardown.
2. **Unowned execution logs.** With execution logging on (cdk-nag APIG6),
   API Gateway creates `API-Gateway-Execution-Logs_<api-id>/<stage>` on its
   first write. No stack owns it, so it is never deleted: 13 were left.
3. **The account-wide CloudWatch role.** `RestApi` creates an
   `AWS::ApiGateway::Account` and a role by default. There is one such
   setting per account and Region. CDK retains the role on destroy so the
   setting keeps working, so every deploy leaves a role behind and points
   every API in the account at it. The integ-tests-alpha assertion Lambda
   also left its `/aws/lambda/...` log group.

## Options considered
### Option 1: Turn execution and access logging off
Pros: nothing to leak. Cons: fails cdk-nag APIG1/APIG6; loses the audit
trail the threat model relies on (M-10).
### Option 2: Delete leftovers in an integ-runner postDestroy hook
Pros: small. Cons: fixes only the test; `cdk destroy` by a reader still
leaks; races the same late delivery.
### Option 3: Order deletion in the stack, own every log group, use the existing account role
A `LogDrain` custom resource sits between writers and log groups:
writers depend on it, and it depends on the log groups, so on delete
CloudFormation removes the writers, the drain waits 90 seconds, then the
log groups go. The waiter has a role with no permissions, so it writes no
logs. The stack creates the execution log group itself, before the stage.
`cloudWatchRole: false`: the stack never touches the account setting.

## Decision
Option 3. Two drains, one for the five functions and one for the API
stage, because the execution log group's name contains the API ID and the
API depends on the functions: one drain would be a dependency cycle. The
integration test's assertion stack holds one `AWS::CloudFormation::WaitConditionHandle`
instead of `awsApiCall` assertions, so no unowned Lambda runs; the R-6
parameter check moves into the e2e scenario.

## Consequences
Easier: destroy is total, and the sample no longer changes an
account-wide setting. Harder: deleting a stack takes about 90 seconds
longer. A deploy needs an API Gateway CloudWatch role already set on the
account and Region, which the README lists as a prerequisite; without it
the stage fails to create. Revisit if API Gateway stops recreating
deleted log groups.
