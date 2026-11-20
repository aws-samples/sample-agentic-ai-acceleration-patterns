// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { ArnFormat, Aws, Stack } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import type { BackendConstruct, SandboxEndpoint } from '../backend-construct';

export interface SandboxEndpointsProps {
  readonly vpc: ec2.IVpc;
  readonly sandboxSubnets: ec2.SubnetSelection;
  readonly backends: readonly BackendConstruct[];
  readonly inputBucket: s3.IBucket;
  readonly runnerRepository?: ecr.IRepository;
  readonly sessionFiles: boolean;
}

const HTTPS = ec2.Port.tcp(443);

/**
 * The sandbox endpoints of spec §3.7, each with a security group and a
 * policy that names only the sample's own repository and log groups. Each
 * is created once, for every backend that asks for it through
 * `BackendConstruct.endpoints()`.
 *
 * Security groups: one for the ECR endpoints and one for the Logs endpoint,
 * with no egress. They admit 443 from every endpoint client of every
 * backend (the sandbox groups and the ECS instance group). A client's own
 * egress rule is added for the endpoints its backend asked for, so a `nitro`
 * task reaches the Logs endpoint only.
 */
export class SandboxEndpoints extends Construct {
  public readonly ecrSecurityGroup?: ec2.ISecurityGroup;
  public readonly logsSecurityGroup?: ec2.ISecurityGroup;

  public constructor(scope: Construct, id: string, props: SandboxEndpointsProps) {
    super(scope, id);
    const wanted = new Set<SandboxEndpoint>(props.backends.flatMap((b) => b.endpoints()));
    if (wanted.size === 0) return;
    const stack = Stack.of(this);
    const subnets = props.sandboxSubnets;

    const securityGroup = (name: string, description: string) => new ec2.SecurityGroup(this, name, {
      vpc: props.vpc,
      description,
      allowAllOutbound: false,
    });

    if (wanted.has('s3-gateway')) {
      const endpoint = new ec2.GatewayVpcEndpoint(this, 'S3', {
        vpc: props.vpc,
        service: ec2.GatewayVpcEndpointAwsService.S3,
        subnets: [subnets],
      });
      const statements = [new iam.PolicyStatement({
        sid: 'EcrLayerBucket',
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:GetObject'],
        resources: [`arn:${Aws.PARTITION}:s3:::prod-${Aws.REGION}-starport-layer-bucket/*`],
      })];
      if (props.sessionFiles) {
        statements.push(
          new iam.PolicyStatement({
            sid: 'SessionObjects',
            principals: [new iam.AnyPrincipal()],
            actions: ['s3:GetObject', 's3:PutObject'],
            resources: [props.inputBucket.arnForObjects('sessions/*')],
          }),
          new iam.PolicyStatement({
            sid: 'SessionList',
            principals: [new iam.AnyPrincipal()],
            actions: ['s3:ListBucket'],
            resources: [props.inputBucket.bucketArn],
            conditions: { StringLike: { 's3:prefix': 'sessions/*' } },
          }),
        );
      }
      statements.forEach((s) => endpoint.addToPolicy(s));
    }

    if (wanted.has('ecr-api') || wanted.has('ecr-dkr')) {
      if (!props.runnerRepository) {
        throw new Error('UntrustedCodeSandboxes: a backend asks for the ECR endpoints but no runner repository exists');
      }
      const sg = securityGroup('EcrEndpointSecurityGroup', 'ECR endpoints in the sandbox subnets (spec 3.7)');
      this.ecrSecurityGroup = sg;
      const policy = [
        new iam.PolicyStatement({
          sid: 'AuthorizationToken',
          principals: [new iam.AnyPrincipal()],
          actions: ['ecr:GetAuthorizationToken'],
          // The action takes no resource; useless without a pull grant (spec 3.7).
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'PullRunnerImage',
          principals: [new iam.AnyPrincipal()],
          actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
          resources: [props.runnerRepository.repositoryArn],
        }),
      ];
      const services: [string, ec2.IInterfaceVpcEndpointService][] = [];
      if (wanted.has('ecr-api')) services.push(['EcrApi', ec2.InterfaceVpcEndpointAwsService.ECR]);
      if (wanted.has('ecr-dkr')) services.push(['EcrDkr', ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER]);
      for (const [name, service] of services) {
        const endpoint = new ec2.InterfaceVpcEndpoint(this, name, {
          vpc: props.vpc, service, subnets, securityGroups: [sg], privateDnsEnabled: true, open: false,
        });
        policy.forEach((s) => endpoint.addToPolicy(s));
      }
    }

    if (wanted.has('logs')) {
      const sg = securityGroup('LogsEndpointSecurityGroup', 'CloudWatch Logs endpoint in the sandbox subnets (spec 3.7)');
      this.logsSecurityGroup = sg;
      const policy: iam.PolicyStatement[] = [];
      const groupArn = (name: string, wildcard: boolean) => stack.formatArn({
        service: 'logs',
        resource: 'log-group',
        resourceName: wildcard ? `${name}*` : `${name}:*`,
        arnFormat: ArnFormat.COLON_RESOURCE_NAME,
      });
      for (const b of props.backends.filter((x) => x.endpoints().includes('logs'))) {
        const { names, prefixes } = b.logCleanup();
        if (names.length > 0) {
          policy.push(new iam.PolicyStatement({
            sid: `Logs${b.name}Groups`,
            principals: [new iam.AnyPrincipal()],
            actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            resources: names.map((n) => groupArn(n, false)),
          }));
        }
        if (prefixes.length > 0) {
          policy.push(new iam.PolicyStatement({
            sid: `Logs${b.name}Prefixes`,
            principals: [new iam.AnyPrincipal()],
            actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
            resources: prefixes.map((p) => groupArn(p, true)),
          }));
        }
      }
      if (policy.length === 0) {
        throw new Error('UntrustedCodeSandboxes: a backend asks for the Logs endpoint but names no log group in logCleanup()');
      }
      const endpoint = new ec2.InterfaceVpcEndpoint(this, 'Logs', {
        vpc: props.vpc,
        service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
        subnets,
        securityGroups: [sg],
        privateDnsEnabled: true,
        open: false,
      });
      policy.forEach((s) => endpoint.addToPolicy(s));
    }

    const groupOf = (e: SandboxEndpoint): ec2.ISecurityGroup | undefined => (e === 'logs' ? this.logsSecurityGroup : e === 's3-gateway' ? undefined : this.ecrSecurityGroup);
    const endpointGroups = [this.ecrSecurityGroup, this.logsSecurityGroup].filter((g): g is ec2.ISecurityGroup => g !== undefined);
    for (const backend of props.backends) {
      for (const client of backend.endpointClients()) {
        // Egress from the client (and ingress on the endpoint group) for the endpoints this backend asked for.
        for (const e of new Set(backend.endpoints())) {
          const target = groupOf(e);
          if (target) client.connections.allowTo(target, HTTPS, `${backend.name} to the ${e} endpoint`);
          // shortcut: the S3 prefix list of the gateway endpoint is not known at synth, so the egress goes to any
          // address on 443; the sandbox subnets route nothing else (ADR-0028). Narrow it when CloudFormation
          // can read the prefix list id.
          if (e === 's3-gateway') client.connections.allowTo(ec2.Peer.anyIpv4(), HTTPS, `${backend.name} to S3 through the gateway endpoint`);
        }
        // The endpoints admit every client, so a group that reaches an endpoint through private DNS is admitted.
        for (const g of endpointGroups) g.addIngressRule(client, HTTPS, `${backend.name} clients`);
      }
    }
  }
}
