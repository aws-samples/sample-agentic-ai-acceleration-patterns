// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/** The published constructs (spec §6.4). */

export { TenantFrontDoor, TenantFrontDoorProps } from './edge/tenant-front-door.cdk';
export {
  ControlPlaneInput,
  HostedZoneInput,
  IssuerInput,
  SigninKeysInput,
  TenantFrontDoorInputs,
  VendorIdpInput,
} from './edge/inputs';
