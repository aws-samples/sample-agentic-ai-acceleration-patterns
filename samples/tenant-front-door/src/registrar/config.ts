// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { ROLE_ARN } from './caller';
import type { Addressing } from '../shared/contracts';
import { REGISTRAR_ENV } from '../shared/contracts';

/**
 * The registrar's configuration, read once at cold start from the
 * environment the main stack sets (`REGISTRAR_ENV`, build slice S2). A
 * missing or malformed value throws, so a bad deploy fails closed instead
 * of writing routes with a guessed setting.
 */
export interface RegistrarConfig {
  readonly routeTableArn: string;
  /** Lower case. */
  readonly appDomain: string;
  readonly addressing: Addressing;
  readonly applicationId: string;
  /** No trailing slash. */
  readonly controlPlaneUrl: string;
  readonly controlPlaneAccount: string;
  readonly controlPlaneRegion: string;
  readonly vendorIdpTokenUrl: string;
  readonly vendorIdpClientId: string;
  readonly vendorIdpSecretArn: string;
  readonly fleet: string;
  readonly edgeOperatorRoleArn: string;
  readonly dedicatedDomains: boolean;
  /** The multi-tenant distribution: the dimension of `RouteTableBytes` (§4.1), and the dedicated-domain seam's. */
  readonly distributionId: string;
}

const ACCOUNT = /^\d{12}$/;
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const APPLICATION_ID = /^[a-z0-9-]{1,32}$/;
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') throw new ConfigError(`${name} is not set`);
  return value.trim();
}

function matching(env: NodeJS.ProcessEnv, name: string, rule: RegExp): string {
  const value = required(env, name);
  if (!rule.test(value)) throw new ConfigError(`${name} is malformed`);
  return value;
}

function httpsUrl(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} is not a URL`);
  }
  if (url.protocol !== 'https:') throw new ConfigError(`${name} is not an https URL`);
  return value.replace(/\/+$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv): RegistrarConfig {
  const addressing = required(env, REGISTRAR_ENV.addressing);
  if (addressing !== 'single' && addressing !== 'host') throw new ConfigError(`${REGISTRAR_ENV.addressing} is not single or host`);
  const dedicated = required(env, REGISTRAR_ENV.dedicatedDomains);
  if (dedicated !== 'on' && dedicated !== 'off') throw new ConfigError(`${REGISTRAR_ENV.dedicatedDomains} is not on or off`);
  const routeTableArn = required(env, REGISTRAR_ENV.routeTableArn);
  if (!routeTableArn.startsWith('arn:')) throw new ConfigError(`${REGISTRAR_ENV.routeTableArn} is not an ARN`);
  const edgeOperatorRoleArn = required(env, REGISTRAR_ENV.edgeOperatorRoleArn);
  if (!ROLE_ARN.test(edgeOperatorRoleArn)) {
    throw new ConfigError(`${REGISTRAR_ENV.edgeOperatorRoleArn} is not an IAM role ARN`);
  }
  const distributionId = required(env, REGISTRAR_ENV.distributionId).trim();
  return {
    routeTableArn,
    appDomain: matching(env, REGISTRAR_ENV.appDomain, HOST),
    addressing,
    applicationId: matching(env, REGISTRAR_ENV.applicationId, APPLICATION_ID),
    controlPlaneUrl: httpsUrl(env, REGISTRAR_ENV.controlPlaneUrl),
    controlPlaneAccount: matching(env, REGISTRAR_ENV.controlPlaneAccount, ACCOUNT),
    controlPlaneRegion: matching(env, REGISTRAR_ENV.controlPlaneRegion, REGION),
    vendorIdpTokenUrl: httpsUrl(env, REGISTRAR_ENV.vendorIdpTokenUrl),
    vendorIdpClientId: required(env, REGISTRAR_ENV.vendorIdpClientId),
    vendorIdpSecretArn: required(env, REGISTRAR_ENV.vendorIdpSecretArn),
    fleet: matching(env, REGISTRAR_ENV.fleet, /^[A-Za-z0-9+=,.@_-]{1,50}$/),
    edgeOperatorRoleArn,
    dedicatedDomains: dedicated === 'on',
    distributionId,
  };
}
