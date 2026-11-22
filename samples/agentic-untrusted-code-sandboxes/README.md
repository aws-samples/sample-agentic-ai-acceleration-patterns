<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Untrusted code sandboxes for agentic applications

One `run_code` tool that runs model-written Python for one tenant at a time
in a per-tenant sandbox: Lambda MicroVMs, Nitro Sandboxes on ECS Managed
Instances, or AgentCore Runtime. The sandboxed code has no internet access
and no tenant credentials.

DNS is the one exception. With `dnsFirewall` off, which is the default, code
can look up any public name, so it can send data out and read replies in
lookups, and on `agentcore` it can send the runtime role's credentials that
way. Turn `dnsFirewall` on to resolve only AWS names plus the `allowDomains`
you list (it needs the VPC the construct creates, not a supplied `vpc`).
Each listed name needs two labels; that refuses only a bare top-level domain,
not a public suffix such as `co.uk` or a shared zone, so you are responsible
for listing only names you control (threats T-29, T-32 and T-91).
With a supplied `vpc`, set `createEndpoints` explicitly: the endpoints use
private DNS that applies to the whole VPC (T-92).

This sample is being built. The design is the contract:

- [Specification](design/agentic-untrusted-code-sandboxes.spec.md)
- [Decisions](adr/README.md)
- [Threat model](threat-model.md)
- [Runner wire protocol](runner/PROTOCOL.md)
- [Conventions for contributors and scripts](scripts/CONVENTIONS.md)

Build and test (Node.js 24, `aws-cdk-lib` 2.274.0):

```bash
npm ci
npx projen build
```

## Known limitations

**A stack delete can stop on two Lambda network interfaces.** In 8 of 9
integration stacks, across three Regions, the delete ended
`DELETE_FAILED` on the tool subnets and the tool security group. Two
Lambda-managed network interfaces (description
`AWS Lambda VPC ENI-<stack>-...Reaper...` or `...Offboard...`, status
`available`) stayed after every function was gone. In the one run traced
with CloudTrail, the reaper role created both interfaces when the
functions were created, and nothing ever tried to delete them; another
role's interfaces in the same delete were deleted by Lambda with that role.

The cause is not proven. Four smaller stacks deleted cleanly: one shared
role, or three roles sharing one security group, each with and without a
wait before the roles are deleted, invoked or not. One deploy of this
construct with the `microvm` backend only also deleted cleanly, in 1449 s
with no network interface left. It was deleted about 30 minutes after it
was created, after three rounds of calls to its tool, reaper and offboard
functions, with a MicroVM live.

To finish a stuck delete, delete the `available` interfaces of the stack,
then the stack again:

```bash
export AWS_PROFILE=<profile> AWS_REGION=<region>
aws ec2 describe-network-interfaces --filters 'Name=description,Values=AWS Lambda VPC ENI-<stack>-*' 'Name=status,Values=available' --query 'NetworkInterfaces[].[NetworkInterfaceId,Status]' --output text
aws ec2 delete-network-interface --network-interface-id <id>
aws cloudformation delete-stack --stack-name <stack>
aws cloudformation wait stack-delete-complete --stack-name <stack>
```
