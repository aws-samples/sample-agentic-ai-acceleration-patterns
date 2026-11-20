// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Stack } from 'aws-cdk-lib';
import type * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import { DockerImageName, ECRDeployment } from 'cdk-ecr-deployment';
import { Construct } from 'constructs';
import { acknowledgeImageCopy } from './nag';

export type RunnerArch = 'arm64' | 'amd64';

/**
 * Copies the runner image into the construct-owned repository, once per
 * architecture, under the tag `runner-<arch>-<asset hash>` (ADR-0024,
 * ADR-0029). A backend asks for the tag with `BackendContext.runnerImageTag`;
 * the first ask builds the image asset and the copy, so a deployment that
 * uses one architecture builds one. The core makes each container backend's
 * resources wait for the copies that backend asked for.
 */
export class RunnerImages extends Construct {
  private readonly built = new Map<RunnerArch, { tag: string; copy: ECRDeployment }>();

  public constructor(scope: Construct, id: string, private readonly props: {
    readonly repository: ecr.IRepository;
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
      acknowledgeImageCopy(Stack.of(this));
      found = { tag, copy };
      this.built.set(arch, found);
    }
    return found;
  }
}
