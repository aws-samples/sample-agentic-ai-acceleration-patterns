// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { RemovalPolicy, Stack } from 'aws-cdk-lib';
import type * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { DockerImageName, ECRDeployment } from 'cdk-ecr-deployment';
import { Construct } from 'constructs';
import type { LogDrain } from './log-drain';
import { acknowledgeImageCopy } from './nag';

export type RunnerArch = 'arm64' | 'amd64';

/** What the singleton copy function of one stack has been given so far; every instance in the stack adds to it. */
interface ProviderState {
  readonly noWriteElsewhere: iam.PolicyStatement;
  readonly noBucket: iam.PolicyStatement;
}

const providers = new WeakMap<Stack, ProviderState>();

/**
 * Copies the runner image into the construct-owned repository, once per
 * architecture, under the tag `runner-<arch>-<asset hash>` (ADR-0024,
 * ADR-0029). A backend asks for the tag with `BackendContext.runnerImageTag`;
 * the first ask builds the image asset and the copy, so a deployment that
 * uses one architecture builds one. The core makes each container backend's
 * resources wait for the copies that backend asked for.
 *
 * The copy library puts one Lambda in the stack, shared by every copy in it,
 * and gives its role ECR write and S3 read on every resource. This class
 * narrows that role with explicit denies (no ECR write outside the runner
 * repositories of the stack, no S3 on the input buckets, no log group
 * creation) and gives the function a log group the construct owns.
 */
export class RunnerImages extends Construct {
  private readonly built = new Map<RunnerArch, { tag: string; copy: ECRDeployment }>();

  public constructor(scope: Construct, id: string, private readonly props: {
    readonly repository: ecr.IRepository;
    readonly inputBucket: s3.IBucket;
    readonly logDrain: LogDrain;
    /** Directory with the runner Dockerfile (`runnerPath()`). */
    readonly runnerDir: string;
  }) {
    super(scope, id);
  }

  /** The tag of the image copy for an architecture; builds the asset and the copy on first use. */
  public tag(arch: RunnerArch): string {
    return this.get(arch).tag;
  }

  /** The copy resource for an architecture, for dependencies. */
  public copy(arch: RunnerArch): ECRDeployment {
    return this.get(arch).copy;
  }

  private get(arch: RunnerArch): { tag: string; copy: ECRDeployment } {
    let found = this.built.get(arch);
    if (!found) {
      const asset = new ecrAssets.DockerImageAsset(this, `Image-${arch}`, {
        directory: this.props.runnerDir,
        platform: arch === 'arm64' ? ecrAssets.Platform.LINUX_ARM64 : ecrAssets.Platform.LINUX_AMD64,
      });
      const tag = `runner-${arch}-${asset.assetHash}`;
      const copy = new ECRDeployment(this, `Copy-${arch}`, {
        src: new DockerImageName(asset.imageUri),
        dest: new DockerImageName(`${this.props.repository.repositoryUri}:${tag}`),
        imageArch: [arch],
      });
      this.constrainProvider(copy);
      found = { tag, copy };
      this.built.set(arch, found);
    }
    return found;
  }

  private constrainProvider(copy: ECRDeployment): void {
    const stack = Stack.of(this);
    const { repository, inputBucket, logDrain } = this.props;
    let state = providers.get(stack);
    if (!state) {
      state = {
        noWriteElsewhere: new iam.PolicyStatement({
          sid: 'EcrWriteOnlyToRunnerRepositories',
          effect: iam.Effect.DENY,
          actions: ['ecr:PutImage', 'ecr:InitiateLayerUpload', 'ecr:UploadLayerPart', 'ecr:CompleteLayerUpload'],
          notResources: [],
        }),
        noBucket: new iam.PolicyStatement({
          sid: 'NoInputBucket',
          effect: iam.Effect.DENY,
          actions: ['s3:*'],
          resources: [],
        }),
      };
      providers.set(stack, state);
      copy.addToPrincipalPolicy(state.noWriteElsewhere);
      copy.addToPrincipalPolicy(state.noBucket);
      copy.addToPrincipalPolicy(new iam.PolicyStatement({
        sid: 'NoLogGroupCreation',
        effect: iam.Effect.DENY,
        actions: ['logs:CreateLogGroup'],
        resources: ['*'],
      }));
      this.ownLogGroup(stack, logDrain);
    }
    state.noWriteElsewhere.addNotResources(repository.repositoryArn);
    state.noBucket.addResources(inputBucket.bucketArn, inputBucket.arnForObjects('*'));
    acknowledgeImageCopy(stack);
    // The function is deleted before the log drain waits, in every instance that uses it.
    logDrain.writer(this.provider(stack).node.defaultChild as lambda.CfnFunction);
  }

  private provider(stack: Stack): Construct {
    const found = stack.node.children.find((c) => c.node.id.startsWith('Custom::CDKECRDeployment'));
    if (!found) throw new Error('the image copy library did not create its function');
    return found as Construct;
  }

  /** Points the shared function at a log group the construct owns, so a destroy leaves none behind (spec 6.2 C-6). */
  private ownLogGroup(stack: Stack, logDrain: LogDrain): void {
    const provider = this.provider(stack);
    const group = new logs.LogGroup(this, 'CopyLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    (provider.node.defaultChild as lambda.CfnFunction).loggingConfig = { logGroup: group.logGroupName };
    group.grantWrite(provider.node.findChild('ServiceRole') as iam.IRole);
    logDrain.protect(group);
  }
}
