// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The integration test's inputs (spec §10) and the names every run derives
 * from its run id. `scripts/integ.sh` builds one JSON object, passes it as
 * the `integ` context to `test/integ.single.ts` or `test/integ.host.ts`, and
 * adds the values each later phase learns (the control plane URL, the
 * registrar URL, the front door's resources) as the run goes. A stack is in
 * the app only once its inputs are, so each deploy phase synthesises what it
 * can deploy. Nothing here holds a token, a secret or a key.
 */

/** What the driver knows about the front door after its main stack is up: the test role's resources (spec §10, test-only shortcuts). */
export interface TestRoleInputs {
  readonly distributionId: string;
  readonly routeTableArn: string;
  readonly routerFunctionArn: string;
  readonly registrarLogGroupArn: string;
  readonly registrarAccessLogGroupArn: string;
  readonly edgeLogGroupArn: string;
  readonly agentIngressLogGroupArn: string;
  readonly cellLogGroupArn: string;
  /** Absent once `dedicatedDomains` is off (step 14). */
  readonly sweeperFunctionArn?: string;
  readonly sweeperTableArn?: string;
  readonly sweeperLogGroupArn?: string;
}

export interface IntegInputs {
  /** `[a-z0-9]{1,10}`, without `aws`, `amazon` or `cognito` (a Cognito domain prefix refuses them): it names every stack and role of the run. */
  readonly runId: string;
  /** The account the driver's credentials point at: the edge account, which holds the hosted zone (spec §10). */
  readonly edgeAccount: string;
  /** The control plane's account, CDK-bootstrapped to trust the edge account. */
  readonly controlPlaneAccount: string;
  /** The control plane's Region, the main stack's and the cells' (spec §3.6). */
  readonly region: string;
  /** The driver's IAM principal (a role or user ARN in the edge account): the only principal the test roles trust. */
  readonly driverPrincipalArn: string;
  readonly appDomain: string;
  readonly hostedZoneId: string;
  readonly zoneName: string;
  /** Step 14's domain: in the zone, outside `appDomain`. */
  readonly dedicatedDomain: string;
  /** The `tenant-identity` shared pool (its published parameters), the issuer every test token comes from. */
  readonly identity: { readonly userPoolId: string; readonly appClientId: string; readonly region: string };
  /** The built SPA; default `build/spa`, which `npx projen spa:build` writes (unit tests pass a fixture). */
  readonly spaSource?: string;
  /** A Cognito domain for the front door's `issuer` input; default reserved example endpoints, as no browser step runs (spec §10). */
  readonly issuerDomain?: string;

  // Learned during the run.
  /** The support stack's vendor IdP: the registrar's reader client (spec §3.6 `controlPlane.vendorIdp`). */
  readonly vendorIdp?: { readonly tokenUrl: string; readonly clientId: string; readonly clientSecretArn: string };
  readonly controlPlaneApiUrl?: string;
  readonly agentIngressUrl?: string;
  readonly registrarUrl?: string;
  readonly distributionArn?: string;
  readonly testRole?: TestRoleInputs;

  // Step-specific stack inputs.
  /** Default true; step 14 turns it off. */
  readonly dedicatedDomains?: boolean;
  readonly tenantRequestsPer5Min?: number;
  /** Step 17 raises it above `tenantRequestsPer5Min`. */
  readonly ipRequestsPer5Min?: number;
}

/** Every name a run derives from its id (spec §10: a per-run prefix, so a run never meets the smoke stacks or another run). */
export interface IntegNames {
  /** Stack name prefix, `TfdInteg-<run id>`. */
  readonly prefix: string;
  /** The control plane's `fleetName`, `tfdi-<run id>`. */
  readonly fleet: string;
  /** The demo application, which has a front door. */
  readonly applicationId: string;
  /** Step 19's application, which has none. */
  readonly plainApplicationId: string;
  readonly stacks: {
    readonly support: string;
    readonly controlPlaneSetup: string;
    readonly controlPlane: string;
    readonly cellAccount: string;
    readonly agentIngress: string;
    readonly edge: string;
    readonly main: string;
    readonly edgeLogging: string;
    readonly routeHookAccess: string;
    readonly cellA: string;
    readonly cellB: string;
    readonly testRole: string;
  };
  readonly roles: {
    readonly edgeOperator: string;
    readonly test: string;
    readonly stranger: string;
    readonly controlPlaneAccess: string;
  };
  /** The test policy the account role pairs carry, so their 403 comes from the registrar's resource policy (steps 11 and 12). */
  readonly pairProbePolicy: string;
}

export const RUN_ID = /^[a-z0-9]{1,10}$/;

export function integNames(runId: string): IntegNames {
  if (!RUN_ID.test(runId) || /aws|amazon|cognito/.test(runId)) {
    throw new Error('integ runId must match [a-z0-9]{1,10} and hold none of aws, amazon, cognito');
  }
  const prefix = `TfdInteg-${runId}`;
  const fleet = `tfdi-${runId}`;
  return {
    prefix,
    fleet,
    applicationId: `tfd-${runId}`,
    plainApplicationId: `plain-${runId}`,
    stacks: {
      support: `${prefix}-support`,
      controlPlaneSetup: `${prefix}-cp-setup`,
      controlPlane: `${prefix}-control-plane`,
      // The control-plane sample names its account role pair stack after the fleet.
      cellAccount: `${fleet}-cell-account`,
      agentIngress: `${prefix}-agent-ingress`,
      edge: `${prefix}-edge`,
      main: `${prefix}-main`,
      edgeLogging: `${prefix}-edge-logging`,
      routeHookAccess: `${prefix}-route-hook-access`,
      cellA: `${prefix}-cell-a`,
      cellB: `${prefix}-cell-b`,
      testRole: `${prefix}-test-role`,
    },
    roles: {
      edgeOperator: `${prefix}-edge-operator`,
      test: `${prefix}-test`,
      stranger: `${prefix}-stranger`,
      controlPlaneAccess: `${prefix}-cp-access`,
    },
    pairProbePolicy: `${prefix}-pair-registrar-probe`,
  };
}

const ACCOUNT = /^\d{12}$/;
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const PRINCIPAL = /^arn:(aws|aws-cn|aws-us-gov):iam::(\d{12}):(role|user)\/[\w+=,.@/-]{1,512}$/;
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);

/** Reads and checks the `integ` context; fails synthesis with the input's name. */
export function parseIntegInputs(raw: unknown): IntegInputs {
  const value = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw;
  if (value === null || typeof value !== 'object') {
    throw new Error('Missing the integ context: scripts/integ.sh passes it (spec §10)');
  }
  const i = value as IntegInputs;
  integNames(i.runId);
  for (const [key, v] of [['edgeAccount', i.edgeAccount], ['controlPlaneAccount', i.controlPlaneAccount]] as const) {
    if (typeof v !== 'string' || !ACCOUNT.test(v)) throw new Error(`integ ${key} must be a 12-digit account id`);
  }
  if (i.edgeAccount === i.controlPlaneAccount) {
    throw new Error('integ controlPlaneAccount must differ from edgeAccount (spec §10: two accounts)');
  }
  if (typeof i.region !== 'string' || !REGION.test(i.region)) throw new Error('integ region must be a Region name');
  const principal = PRINCIPAL.exec(String(i.driverPrincipalArn));
  if (principal === null || principal[2] !== i.edgeAccount) {
    throw new Error('integ driverPrincipalArn must be an IAM role or user ARN in the edge account');
  }
  const zoneName = String(i.zoneName).toLowerCase();
  const appDomain = String(i.appDomain).toLowerCase();
  const dd = String(i.dedicatedDomain).toLowerCase();
  for (const [key, v] of [['zoneName', zoneName], ['appDomain', appDomain], ['dedicatedDomain', dd]] as const) {
    if (!HOSTNAME.test(v)) throw new Error(`integ ${key} must be a host name`);
  }
  if (!appDomain.endsWith(`.${zoneName}`)) throw new Error('integ appDomain must be a name below the zone\'s apex (spec §10)');
  if (!dd.endsWith(`.${zoneName}`) || dd === appDomain || dd.endsWith(`.${appDomain}`)) {
    throw new Error('integ dedicatedDomain must be a second name in the zone, outside appDomain (spec §10)');
  }
  if (typeof i.hostedZoneId !== 'string' || !/^Z[A-Z0-9]{1,31}$/.test(i.hostedZoneId)) throw new Error('integ hostedZoneId must be a Route 53 zone id');
  const id = i.identity;
  if (id === undefined || typeof id.userPoolId !== 'string' || typeof id.appClientId !== 'string' || !REGION.test(String(id.region))) {
    throw new Error('integ identity needs the tenant-identity shared pool\'s userPoolId, appClientId and region');
  }
  if (i.issuerDomain !== undefined && !/^https:\/\/[a-z0-9.-]+$/.test(i.issuerDomain)) {
    throw new Error('integ issuerDomain must be an https origin');
  }
  return { ...i, appDomain, zoneName, dedicatedDomain: dd };
}

/** The shared pool's issuer URL, as its tokens carry it. */
export function identityIssuer(i: IntegInputs): string {
  return `https://cognito-idp.${i.identity.region}.amazonaws.com/${i.identity.userPoolId}`;
}
