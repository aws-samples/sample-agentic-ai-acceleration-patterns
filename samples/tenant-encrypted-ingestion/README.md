<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Per-Tenant Encrypted Ingestion for Agentic Applications

Agentic applications are fed with tenant documents (contracts, loan files,
case packages), and every tenant shares one drop zone and one pipeline. This
sample encrypts each tenant's documents with that tenant's own AWS KMS key
and makes KMS and IAM, not application code, keep them apart. A tenant user
gets a presigned, write-once PUT under an opaque object key; S3 encrypts the
upload with the tenant's key; the pipeline validates it under a
tenant-scoped session, structural checks first and then the deployer's own
validator chain, and only then lands it under `documents/<tenantId>/` and
publishes `DeliveryAccepted` for the agents and extraction pipelines that act
for that tenant. Two key tiers share one contract: `vendor-key`, a key the
vendor owns, and `tenant-key`, a key in the tenant's own account that the
tenant can withdraw at any time, after which the pipeline fails closed.
Offboarding is cryptographic: the key is scheduled for deletion and every
object encrypted with it becomes unreadable (ADR-0001, ADR-0004, ADR-0005).

It ships as one CDK construct, **`TenantEncryptedIngestion`**, plus a thin
demo stack, an integration test, a demo script and an example validator
([`examples/validator-pdf-pages`](./examples/validator-pdf-pages/handler.ts)).

**What this sample is NOT** (spec §1.2):

- Not a transfer endpoint. No SFTP or upload page; tenants PUT to a
  presigned URL. AWS Transfer Family is a seam (spec §11).
- Not client-side encryption. SSE-KMS: S3 and the pipeline see plaintext
  behind TLS. A sealed-drop tier is a seam (spec §11).
- Not OpenPGP. KMS gives what a PGP drop would, natively.
- Not document understanding. No extraction or model calls; the pipeline
  lands the document and publishes `DeliveryAccepted` for a later sample.
- Not malware scanning or content rules. The built-in checks are
  structural; anything more is a custom validator.
- Not identity. The demo authenticates tenant users with
  [`tenant-identity`](../tenant-identity/); the construct verifies a token
  contract any OIDC issuer can meet (ADR-0019).
- Not a control plane, and not multi-Region.

The two tiers side by side (spec §1.3):

| | `vendor-key` | `tenant-key` |
|---|---|---|
| Key owner | vendor account | tenant account |
| Who can revoke | vendor (offboarding) | tenant, at any time |
| Rotation | KMS automatic (yearly) plus on demand | tenant's own |
| Tenant needs an AWS account | no | yes |
| Tenant onboarding steps | none | create key, tag it, set key policy, hand over ARN |
| Pipeline failure when the key is gone | n/a | fails closed, `KEY_UNAVAILABLE` |
| Cost to the vendor | $1 per key-month plus requests | requests only |
| Cost to the tenant | none | $1 per key-month |

## Architecture

![Components: (1) a tenant user presents an access token to the ingestion API and gets an uploadUrl back; (2) the user PUTs the file to that URL, straight into the drop prefix, with the headers as given; (3) an Object Created event via SQS wakes the processor, which (4) validates the object and copies it pinned under the tenant's key into the documents prefix; (5) the downstream consumer reads it after a DeliveryAccepted event; the API and the processor use the tenant keys, registry, tenant roles, validators, sweep and watch, and delivery bus; the vendor drives key lifecycle through the platform API; each box names the pattern it carries](./diagrams/tenant-encrypted-ingestion.components.drawio.svg)

Each box is one component and its pill names the pattern it carries. The
tenant user makes two calls: `CreateDelivery` on the ingestion API, which
takes the tenant from the verified claim only and answers with a URL presigned
under a tenant-role session, the tenant's key fixed in the signed headers; then
a PUT of the file to that URL, which lands in the drop prefix without passing
through the API. The processor assumes the tenant's process role before reading anything,
validates and then lands the object under `documents/<tenantId>/`, and the
consumer role may decrypt under that prefix only. Shared components on the
second row are reached under tenant-role sessions: the key policy and the
roles' own ABAC policies hold the tenants apart even when code omits a check.

![Architecture: a tenant user holds an access token from tenant-identity and calls the ingestion API's /tenant/* routes through a token authoriser; the API Lambda assumes the tenant upload role with a TenantId session tag, writes the delivery row in the DynamoDB registry and returns a presigned PUT with the tenant's KMS key fixed in the signed headers. The upload lands under ingest/<tenantId>/ in the shared S3 bucket, which asks KMS for a data key from that tenant's key; the key policy admits only the three tenant roles via S3 on the tenant's own prefixes. An Object Created event on the default EventBridge bus goes to an SQS queue with a DLQ; the processor Lambda assumes the tenant process role, runs the structural checks and invokes the deployer's custom validators in order, each with a short-lived single-object URL, then copies the document to documents/<tenantId>/ and publishes DeliveryAccepted, Rejected or KeyUnavailable on the sample's event bus for a downstream consumer, whose consumer role may decrypt under documents/<tenantId>/ only. The vendor calls /platform/* with IAM; the platform Lambda creates keys through the key factory, rotates them and schedules their deletion. An hourly sweep expires and abandons stale deliveries and re-checks revoked keys, a registry watch on the table stream alarms when a key binding changes, and server access logs go to a separate access-log bucket with a single reader. In the tenant-key tier the key lives in the tenant's own AWS account, tagged TenantId, with a key policy that trusts the three tenant roles](./diagrams/tenant-encrypted-ingestion.drawio.svg)

A tenant user asks the API for a delivery, PUTs the file to a presigned URL
that fixes the tenant's key, S3 encrypts it with that key, an `Object
Created` event queues it for the processor, which validates it under a
tenant session, lands it under `documents/<tenantId>/` and publishes a
`Delivery*` event for consumers.

Components ([`architecture.md` §3](./architecture.md#3-components) has the
code locations):

- **Ingestion bucket**: one versioned S3 bucket, `ingest/<tenantId>/` for
  drops and `documents/<tenantId>/` for landed documents, Bucket Keys off,
  a deny-only bucket policy, server access logs to a separate bucket
  ([§6](./architecture.md#6-bucket)).
- **Tenant keys**: one symmetric KMS key per `vendor-key` tenant, created at
  run time by a dedicated key factory, never a stack resource; a
  `tenant-key` key lives in the tenant's account
  ([§5](./architecture.md#5-key-policies), ADR-0001, ADR-0002).
- **Registry**: one DynamoDB table, a partition per tenant (`TENANT#<t>`),
  holding the key binding and the delivery rows, with a stream the
  registry watch reads ([§7](./architecture.md#7-data-model), ADR-0010).
- **Ingestion API**: API Gateway REST with Smithy-generated handlers;
  `/tenant/*` behind a token authoriser that verifies the tenant-identity
  token contract, `/platform/*` behind IAM ([§8](./architecture.md#8-api),
  ADR-0011).
- **Pipeline**: `Object Created` on the default EventBridge bus, an SQS
  queue with a DLQ, and the processor Lambda, one message per invocation
  ([§9](./architecture.md#9-pipeline), ADR-0007, ADR-0009).
- **Validator chain**: deployer-supplied Lambda functions, wrapped in
  `LambdaValidator`, invoked in order with a single-object presigned GET;
  they hold no AWS permission ([§10](./architecture.md#10-validator-chain),
  ADR-0008).
- **Delivery bus**: the construct's own EventBridge bus for
  `DeliveryAccepted`, `DeliveryRejected` and `DeliveryKeyUnavailable`.
- **Sweep and registry watch**: an hourly Lambda that expires abandoned
  uploads, ends abandoned leases, republishes owed events and re-probes
  revoked keys; a stream Lambda that alarms on a changed key binding
  ([§9.4](./architecture.md#94-sweep-and-registry-watch)).
- **Roles**: seven base roles, one per function, and three tenant roles
  assumed with a `TenantId` session tag; every call made for a tenant is
  signed by a tenant-role session ([§4](./architecture.md#4-roles-and-policies),
  ADR-0003).

## How it works

The primary flow, a `vendor-key` tenant delivering one PDF
([`architecture.md` §8](./architecture.md#8-api) and
[§9](./architecture.md#9-pipeline) for depth):

1. **Onboard the key.** The vendor calls `CreateTenantKey` (SigV4). The key
   factory creates a key with the tenant's key policy, tags `TenantId=<t>`,
   adds `alias/tenant-<t>-ingestion` and turns rotation on, writes the key
   row and a `KEYARN#` binding in one transaction, probes the key through S3
   under a tenant session, and flips the row to `ACTIVE`.
2. **`CreateDelivery`.** A tenant user sends `{fileName, contentType,
   sizeBytes}` with a token carrying `ingestion/deliver`. The handler takes
   the tenant only from the verified claim, creates the delivery row and
   adds 1 to the tenant's `inFlight` in one transaction (429 at
   `maxInFlightPerTenant`), and returns a URL presigned by a
   `tenantUploadRole` session.
3. **Presigned PUT.** The URL is for `ingest/<t>/<deliveryId>` and signs six
   headers: SSE `aws:kms`, the tenant's key id, bucket key `false`,
   `If-None-Match: *`, `Content-Length` and `Content-Type`. Changing any of
   them, or the path, is refused; a second PUT is 412 (ADR-0006).
4. **Event.** S3 encrypts the object with the tenant's key and emits `Object
   Created`; a rule on `ingest/` sends it to the queue.
5. **Processor lease.** The processor reads the tenant from the object key's
   second segment only, assumes `tenantProcessRole` for it before reading
   anything, loads the rows with consistent reads and takes a lease
   (`PROCESSING`, `leaseOwner` the SQS message id).
6. **Structural checks.** `HeadObject` pins the ETag and version and checks
   the key, storage class and size; one pinned `GetObject` checks magic
   bytes against the declared type, walks a ZIP's central directory and
   computes `sha256`.
7. **Validator chain.** Each validator gets one synchronous invoke with a GET
   presigned by the tenant session, `If-Match` signed, valid
   `validatorObjectUrlTtlSeconds`; the first `REJECT` stops the chain
   (`<name>:<code>`).
8. **Copy.** `CopyObject` to `documents/<t>/<deliveryId>`, pinned to the
   ETag, SSE-KMS with the tenant's key, `Content-Disposition` carrying the
   file name.
9. **Flip.** One transaction writes the terminal status and the key row's
   counters, conditional on the lease owner.
10. **Delete version.** The processor deletes exactly the drop version it
    read.
11. **Publish.** `DeliveryAccepted` (or `DeliveryRejected`) on the bus, then
    `eventPublishedAt`. A crash at any point leaves a lease the next receive
    retakes or an `OWED` row the sweep finishes.

Any S3 error that is a 403 or names KMS triggers a probe through S3 under the
same session; a KMS-sourced probe failure ends the delivery as
`KEY_UNAVAILABLE` and marks the tenant `REVOKED`, while a probe success
rethrows, so a pipeline fault never revokes a tenant
([§9.2](./architecture.md#92-classifier-and-probe), ADR-0004).

Two walls keep tenants apart, each proven alone by the integration test
(steps 5 and 6):

- **The key policy.** Each key admits only the three tenant roles and the
  deployer's consumer roles, only via S3, only with an encryption context
  under that tenant's own two prefixes; separate Deny statements refuse
  every other principal, every direct call and every other prefix
  ([§5.1](./architecture.md#51-vendor-key-as-built), ADR-0002).
- **Identity-policy ABAC.** The tenant roles' own identity policies scope S3
  to `<prefix>/${aws:PrincipalTag/TenantId}/*`, KMS to keys tagged with the
  same tenant and the registry to `TENANT#${aws:PrincipalTag/TenantId}`; the
  trust policies fix the tag key and keep separators out of its value. Code
  that omits a check still holds only the role's policy
  ([§4.2](./architecture.md#42-tenant-roles), ADR-0003).

## Deploy

Prerequisites:

- An AWS account, non-production, bootstrapped for AWS CDK in the Region you
  deploy to. The integration test runs in the Region `AWS_REGION` names;
  the last run was in `eu-central-1`.
- **Node.js 24**, and the **Smithy CLI** for a build from source: `npx
  projen build` runs `smithy build` before every compile to generate the
  server SDKs from [`model/`](./model/). Docker is not needed: the
  functions bundle locally with esbuild.
- **tenant-identity, topology `shared-pool`, deployed first** in the same
  account and Region, with its parameters published. The demo stack reads
  `/application-plane/shared/identity/{userPoolId,appClientId}` for the
  issuer and `{apiUrl,platformInvokePolicyArn}` to register the scopes
  `ingestion/deliver` and `ingestion/read` in its scope catalogue
  (`PUT /platform/scopes/{scope}`) at deploy. Deploy it from
  [`../tenant-identity`](../tenant-identity/README.md#deploy):

  ```bash
  cd ../tenant-identity
  npm ci
  npx projen build
  npx cdk deploy --context topology=shared-pool
  cd ../tenant-encrypted-ingestion
  ```

  A tenant reaches the API only when tenant-identity entitles it to the two
  scopes (`"scopes": ["ingestion/deliver", "ingestion/read"]` on
  `POST /platform/tenants`).
- **An API Gateway CloudWatch Logs role already set on the account and
  Region.** The API writes access logs but the construct does not create the
  account-wide role (`cloudWatchRole: false`). Check with `aws apigateway
  get-account`; if `cloudwatchRoleArn` is null, set one as described in
  [tenant-identity's Deploy section](../tenant-identity/README.md#deploy).
- **For the `PutKeyPolicy` alarm**: a CloudTrail trail delivering management
  events to EventBridge in the vendor account. Without it the rule never
  fires and the alarm stays silent (threat model M-25).
- **For the `tenant-key` tier**: deploy with `allowTenantKeys=true`, and a
  second AWS account per tenant that brings its own key. In that account the
  tenant creates a single-Region `SYMMETRIC_DEFAULT` key in the bucket's
  Region, tags it `TenantId=<tenantId>`, sets the key policy below, and hands
  the key ARN to the vendor, who calls `CreateTenantKey` with
  `{"tier": "tenant-key", "keyArn": "<keyArn>"}`. KMS tag and policy changes
  take up to five minutes to apply.

The `tenant-key` key policy (spec §7.3), verbatim from
`buildTenantKeyTemplate` in [`src/platform/key-policy.ts`](./src/platform/key-policy.ts),
which [`src/index.ts`](./src/index.ts) exports. `444455556666` is the
tenant's account; the three tenant role ARNs are the published
`tenantRoleArns` parameter (`upload,process,platform`); the consumer role
ARNs are `consumerRoleArns` (drop the last statement when it is `none`);
`<bucketName>` is the published `bucketName`. The first statement keeps the
tenant account's own administration; the tenant may add its own Denies, and
never a grant.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TenantAccountAdministration",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::444455556666:root"
      },
      "Action": "kms:*",
      "Resource": "*"
    },
    {
      "Sid": "VendorTenantRolesUseViaS3OnTenantPrefixes",
      "Effect": "Allow",
      "Principal": {
        "AWS": [
          "<uploadRoleArn>",
          "<processRoleArn>",
          "<platformRoleArn>"
        ]
      },
      "Action": [
        "kms:GenerateDataKey",
        "kms:Decrypt"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "kms:ViaService": "s3.<region>.amazonaws.com"
        },
        "StringLike": {
          "kms:EncryptionContext:aws:s3:arn": [
            "arn:aws:s3:::<bucketName>/ingest/<tenantId>/*",
            "arn:aws:s3:::<bucketName>/documents/<tenantId>/*"
          ]
        }
      }
    },
    {
      "Sid": "VendorTenantRolesDescribeKey",
      "Effect": "Allow",
      "Principal": {
        "AWS": [
          "<uploadRoleArn>",
          "<processRoleArn>",
          "<platformRoleArn>"
        ]
      },
      "Action": "kms:DescribeKey",
      "Resource": "*"
    },
    {
      "Sid": "VendorConsumerRolesDecryptLandedDocuments",
      "Effect": "Allow",
      "Principal": {
        "AWS": [
          "<consumerRoleArn>"
        ]
      },
      "Action": [
        "kms:Decrypt"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "kms:ViaService": "s3.<region>.amazonaws.com"
        },
        "StringLike": {
          "kms:EncryptionContext:aws:s3:arn": [
            "arn:aws:s3:::<bucketName>/documents/<tenantId>/*"
          ]
        }
      }
    }
  ]
}
```

`CreateTenantKey` refuses (422 `KeyNotUsable`) a key in the vendor's
account, an alias or bare id, a key in another Region, a multi-Region,
disabled or non-symmetric key, and a key not tagged for the tenant: the
tenant-role session for `<t>` is admitted to `DescribeKey` only when the
tag matches, so admission proves the tag
([§5.2](./architecture.md#52-tenant-key-template), ADR-0004).

Build, then deploy:

```bash
npm ci
npx projen build
npx cdk deploy
```

`npx projen build` generates the Smithy SDKs, compiles, runs the unit tests
and cdk-nag, and synthesises with `--context identityParameterPlaceholders=true`
so it needs no AWS account. A template synthesised with placeholders carries
a CloudFormation rule that refuses to deploy.

The demo stack, `TenantEncryptedIngestion`, takes its inputs as CDK context
keys, parsed by `parseDemoContext` in [`src/demo.cdk.ts`](./src/demo.cdk.ts).
Synthesis fails fast and names the key when a value is malformed.

| Context key | Values | Default | What it does |
|---|---|---|---|
| `identityParameterPlaceholders` | `true`, `false` | `false` | Build only: synthesise with placeholder pool, client and API values instead of reading tenant-identity's parameters; the rule above refuses to deploy the result |
| `identityParams` | an SSM path prefix ending in `/` | `/application-plane/shared/identity/` | Where tenant-identity's published parameters are read from |
| `allowTenantKeys` | `true`, `false` | `false` | Enable the `tenant-key` tier. With `false`, `CreateTenantKey` with `tenant-key` is 400 `UnsupportedInDeployment`. (The integration app sets it from its own `tenantKeyAccount` context, below; the demo stack has no `tenantKeyAccount` key) |
| `consumerRoleArns` | comma-separated IAM role ARNs, e.g. `arn:aws:iam::111122223333:role/ExtractionReader` | none | The roles that may decrypt landed documents (key policy statement 2b). Fixed into each key's policy at key creation, so decide them before the first tenant is onboarded. Published as `none` when empty |
| `accessLogReaderRoleArn` | an IAM role ARN | none | The one principal the access-log bucket lets read objects; unset, nobody can |
| `redriveOperatorRoleArn` | an IAM role ARN | none | The queue's one sender besides the EventBridge rule, for a DLQ redrive; unset, no redrive |
| `integProfile` | `true`, `false` | `false` | Apply the spec §10 test profile: `maxReceiveCount 1`, `visibilityTimeoutFactor 2`, `abandonGraceSeconds 60`, `uploadUrlTtlSeconds 120`, `maxInFlightPerTenant 5`, `tenantThrottle` 10 rps / burst 20 |
| `maxReceiveCount`, `visibilityTimeoutFactor`, `abandonGraceSeconds`, `uploadUrlTtlSeconds`, `maxInFlightPerTenant` | integers | construct defaults 3, 6, 3600, 900, 100 | Per-prop overrides applied over the profile; the construct validates the ranges (spec §3.3) and fails synth naming the prop |

The demo stack wires two validators: `pdf-pages`
([`examples/validator-pdf-pages`](./examples/validator-pdf-pages/handler.ts),
page limit 3) and `test-switch`, whose behaviour the integration test sets
through an SSM parameter (it accepts by default). It publishes, under
`/application-plane/shared/ingestion/`: `apiUrl`, `bucketName`,
`tenantRoleArns` (`upload,process,platform`), `consumerRoleArns` (or
`none`), `eventBusArn`, `accessLogBucketName`. The names are account-wide,
so one stack per account and Region publishes them; the integration test's
stack, `TenantEncryptedIngestionInteg`, publishes the same names, so run
the test in an account without the demo stack.

Teardown:

```bash
npx cdk destroy
```

Every resource has `RemovalPolicy.DESTROY`; the bucket is emptied by CDK's
auto-delete provider, which the bucket policy exempts. On delete, a drain
custom resource schedules every registered `vendor-key` key for deletion
(and, as a backstop, any key tagged with this stack the registry no longer
knows), and a log drain holds the log groups 90 s so late log delivery
cannot recreate one. What survives: the `vendor-key` keys, `PendingDeletion`
for `keyDeletionWindowDays` (default 7) and counting against the account's
key quota until then; `tenant-key` keys, which belong to the tenants and are
never touched. The scope registration removes `ingestion/deliver` and
`ingestion/read` from tenant-identity's catalogue. Destroy tenant-identity
afterwards from its own directory if nothing else uses it.

### Bring your own identity provider

tenant-identity is what the demo stack, the integration test and the demo
script use; the construct itself does not need it and never reads
tenant-identity's parameters (ADR-0019). `identity` takes any OIDC issuer:
`discoveryUrl` is the issuer's discovery document (the verifier reads
`issuer` and `jwks_uri` from it) and `allowedClientIds` the clients whose
tokens it admits. `identityApi` is required: set it to `'none'`, define the
two scopes `ingestion/deliver` and `ingestion/read` in your own provider,
and have the provider issue the `tenant_id` claim. The construct then
creates no scope registration. Nothing else in it talks to tenant-identity.
This path is covered by unit tests only; the integration run of 2026-11-09
used tenant-identity (Cognito) tokens.

```ts
const ingestion = new TenantEncryptedIngestion(this, 'Ingestion', {
  identity: {
    discoveryUrl: 'https://login.example.com/.well-known/openid-configuration',
    allowedClientIds: ['ingestion-api'],
  },
  identityApi: 'none',
  validators: [new LambdaValidator(pageLimitFn, { name: 'pdf-pages', timeout: Duration.seconds(30) })],
});
```

The access token the verifier admits
([`src/shared/verifier.ts`](./src/shared/verifier.ts), M-1):

| Check | Cognito and tenant-identity | Any other OIDC issuer |
|---|---|---|
| Signature | RS256 only, a key in the issuer's JWKS | same |
| `iss`, `exp` | match the discovery document; not expired | same |
| Client | `client_id` in `allowedClientIds` | `aud` (a string or an array) holds a value in `allowedClientIds`; when `client_id` is present it decides alone |
| Access token, not ID token | `token_use: access` | JOSE header `typ: at+jwt` (RFC 9068; `application/at+jwt` too); a token with neither mark is refused |
| `sub` | non-empty | same |
| `tenant_id` | one string matching `^[A-Za-z0-9][A-Za-z0-9-]{1,34}$`; a `tenants` claim refuses the token | same |
| `scope` | space-separated; the handler checks `ingestion/deliver` or `ingestion/read` per route | same |

Your provider therefore has to put the tenant into a `tenant_id` claim, one
tenant per token, and mark its access tokens. For Okta, Auth0, Entra ID and
Keycloak that is a custom claim on the access token plus the standard
`at+jwt` header they already set. The authoriser result is cached per token
for up to 300 s, so a revoked token keeps working for that long (M-1).

### Use the construct in your own app

Declare this sample as a local dependency (`file:../tenant-encrypted-ingestion`)
in your `.projenrc.ts` and import from its package entry,
[`src/index.ts`](./src/index.ts) (standard §1.1). The construct creates none
of its dependencies and publishes nothing: it takes the issuer, the consumer
roles and the validators as props and hands back what the next component
needs as read-only properties. `identityApi` is required and the
construct reads no parameter to fill it: with tenant-identity, pass its
scope-catalogue API (`apiUrl`) and the managed policy that may call it
(`platformInvokePolicyArn`), read from its published parameters as the demo
stack does, and the construct registers its two scopes there at deploy
(ADR-0019).

```ts
import { Duration } from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { LambdaValidator, TenantEncryptedIngestion } from 'tenant-encrypted-ingestion/src';

const identityParam = (name: string) =>
  ssm.StringParameter.valueForStringParameter(this, `/application-plane/shared/identity/${name}`);
const userPoolId = identityParam('userPoolId');
const appClientId = identityParam('appClientId');

const ingestion = new TenantEncryptedIngestion(this, 'Ingestion', {
  identity: {
    discoveryUrl: `https://cognito-idp.${this.region}.amazonaws.com/${userPoolId}/.well-known/openid-configuration`,
    allowedClientIds: [appClientId],
  },
  identityApi: {
    // where ingestion/deliver and ingestion/read are registered at deploy
    apiUrl: identityParam('apiUrl'),
    platformInvokePolicyArn: identityParam('platformInvokePolicyArn'),
  },
  consumerRoles: [extractionRole], // fixed into each key's policy at key creation
  validators: [
    new LambdaValidator(pageLimitFn, { name: 'pdf-pages', timeout: Duration.seconds(30) }),
    new LambdaValidator(formTypeFn, { name: 'form-type', timeout: Duration.minutes(2) }),
  ],
});

// Read-only properties for the next component (spec §3.4)
ingestion.apiUrl;                  // the API base URL, stage v1
ingestion.bucket.bucketName;       // landed documents under documents/<tenantId>/
ingestion.eventBus.eventBusArn;    // DeliveryAccepted, DeliveryRejected, DeliveryKeyUnavailable
ingestion.tenantRoles.upload.roleArn; // with .process and .platform: what a tenant-key policy trusts
ingestion.accessLogBucket.bucketName;
```

A validator is any Lambda function that answers the §3.5 contract: it gets
`{version, tenantId, deliveryId, fileName, contentType, sizeBytes, sha256,
objectUrl, etag, objectUrlExpiresAt, previous}` and returns
`{"version": "1", "verdict": "ACCEPT"}` or `{"version": "1", "verdict":
"REJECT", "code": "TOO_MANY_PAGES", "message": "5 pages, limit 3"}`.
`LambdaValidator` grants the processor `lambda:InvokeFunction` on the
function and the function nothing; it reads the document through the
presigned URL only. Validator names match `[a-z0-9-]{1,32}` and are unique;
each declared timeout is at most 10 minutes and adds to the processor's
timeout T, which must stay within 900 s or synth fails. The other props
(`allowTenantKeys`, `keyRotation`, `keyDeletionWindowDays`,
`maxObjectSizeBytes`, `allowedContentTypes`, `tenantThrottle`,
`perTenantMetrics`, the timings and limits) are in spec §3.3, with
`DEFAULTS` exported beside the construct.

## Deployment integration test

The deployment integration test
([`test/integ.ingestion.ts`](./test/integ.ingestion.ts), driven by
[`scripts/integ.sh`](./scripts/integ.sh) with the app
[`test/integ/app.ts`](./test/integ/app.ts)) is the reference implementation
of this sample's wiring ([sample standard §5.2](../../docs/sample-standard.md#5-tests)):
it reuses tenant-identity through its published parameters, deploys the
sample's own demo stack, drives the flow through the public API and the
published parameters under `/application-plane/shared/ingestion/`, and
tears down what it deployed. Run it in exactly one Region: set
`AWS_REGION`; the script fails fast when it is unset.

One shortcut is a test's only. The driver is a separate process, so it
cannot read construct properties; `scripts/integ.sh` deploys with the CDK
CLI's `--outputs-file`, and the driver reads the test's own stacks' outputs
from that file: the processor and sweep function names, queue and DLQ URLs
and ARNs, the registry table, event bus, log group, Contributor Insights
rule and alarm names, the pipeline timing and the test-switch parameter
from the demo stack, and the probe, consumer, scratch and capture
resources from the test-aid stack. These are test-only wiring standing for
the construct properties (`processorFunction`, `queue`, `registryTable`,
...) that your own CDK code reads; do not copy them as the composition
contract, which is the published parameters
([ADR-0014](./adr/0014-drive-the-integration-test-with-the-cdk-cli-and-read-test-wiring-from-outputs.md)).

```bash
export AWS_REGION=eu-central-1 && npx projen integ
```

To exercise the `tenant-key` tier across accounts, name a profile for a
second account:

```bash
export AWS_REGION=eu-central-1 && TEI_TENANT_KEY_PROFILE=<profile> npx projen integ
```

Its account becomes the `tenantKeyAccount` context (which turns
`allowTenantKeys` on), and tenant B's key is created, tagged, disabled and
re-enabled there and scheduled for deletion at the end. Without it B is a
second `vendor-key` tenant and the run says the cross-account claim is not
exercised. The second account's credentials must last the whole run: its
steps fall at about minutes 10 and 60. tenant-identity's access tokens live
five minutes, so the driver re-issues a run-issued token on a 401 and
retries once.

**Account guard.** The script runs only in an account that carries the
Organizations tag `tei:test-account` or the SSM parameter
`/tenant-encrypted-ingestion/test-account` set to `true`, and refuses any
other (M-33). A member account cannot read its own Organizations tags, so
the parameter is the usual marker; set it once in a non-production test
account.

**What it stands up.** It reuses the account's tenant-identity `shared-pool`
deployment, deploying it through its own path only when none is published,
and never destroys it: the pool is the test account's shared fixture. It
then synthesises the integration app into `cdk.integ.out/` and deploys two
stacks with the CDK CLI: the **test-aid stack**
(`TenantEncryptedIngestionTestAid`: `TestProbeRole`, `TestConsumerRole`, a
scratch bucket and scratch key built from the same policy builders with a
mistaken Allow for the probe role, an event capture queue, and the redrive
and access-log reader roles) and the **demo stack**
(`TenantEncryptedIngestionInteg`, the sample's own demo stack with the test
profile, `TestConsumerRole` as consumer).
The driver deletes the tenants it created in the shared pool before it
exits and names any it could not delete. Teardown runs from the exit trap,
also on failure, and fails the run if a stack with the sample's prefix is
left or a key it tagged is not `PendingDeletion`.

| Step | What it checks |
|---|---|
| 0 | Prelude: tenants A, B and D created in tenant-identity, entitled to `ingestion/deliver` and `ingestion/read` |
| 1 | `CreateTenantKey` A `vendor-key` and B `tenant-key` (second account) both `ACTIVE`; untagged, wrongly tagged, vendor-account and another tenant's key are 422 `KeyNotUsable` |
| 2 | Tenant users with both scopes, and one token with `ingestion/read` only |
| 3 | Happy path: A and B deliver a PDF, `ACCEPTED`, landed with the tenant's key and the file name; one `DeliveryAccepted` without a key ARN; read-only token: `CreateDelivery` 403, `GetDelivery` 200 |
| 4 | The uploader cannot change the request: another key, no SSE, another length, `GLACIER` are 403; a second PUT is 412; an edited path is `SignatureDoesNotMatch` |
| 5 | Each key-policy Deny alone against the scratch key's mistaken Allow, by error message; the bucket Deny with the `aws/s3` key; the identity-policy wall with `SimulatePrincipalPolicy` on the deployed tenant roles |
| 6 | Cross-tenant read: `TestConsumerRole` for A reads A's landed document, is refused B's by S3; `TestProbeRole` on B's is refused by KMS |
| 7 | Rejections and limits: `TYPE_MISMATCH`, oversize 400, an unused URL `EXPIRED` by the sweep, tenant D's sixth open delivery 429 |
| 7b | Validators: a 5-page PDF is `pdf-pages:TOO_MANY_PAGES` without invoking `test-switch`; mode `throw` is `test-switch:VALIDATOR_ERROR` with the message in the DLQ; no log line holds a signature or file name |
| 7c | Abandoned lease: mode `sleep` outlasts the processor; the sweep ends it as `PROCESSING_ABANDONED` and publishes |
| 8 | Revocation decided by the probe: B's key disabled mid-delivery, then its use statement removed: `KEY_UNAVAILABLE`, `REVOKED`, DLQ unchanged, `CreateDelivery` 409; back to `ACTIVE` after the sweep |
| 9 | Rotation: `RotateTenantKey` A 200 and step 3's document still reads; B 400 `UnsupportedInTier` |
| 10 | Observability: one processor line per delivery with `tenantId`, `status`, `kmsRequests`; `kmsRequests` compared with CloudTrail (informational); the access-log `Requester` (best effort) |
| 10b | Cost attribution: A's registry counters (`GetTenantKey`) equal the tenant's own `ListDeliveries` view (`deliveriesAccepted`, `deliveriesRejected`, `bytesStored` as the sum of accepted `sizeBytes`, `kmsRequests` at least four per accepted and one per processor-refused delivery, `inFlight` 0); A's key carries the `TenantId` cost allocation tag; the `tei-top-bytes` and `tei-top-deliveries` Contributor Insights reports name A with the same figures |
| 11 | Offboarding: `DeleteTenantKey` A 202, no version left under A's prefixes, alias gone, key `PendingDeletion`, `CreateDelivery` A refused, the in-flight PUT fails; `DeleteTenantKey` B leaves B's key untouched and writes the tombstone without an alarm |
| 12 | Teardown, by `scripts/integ.sh`: `cdk destroy --all`, then the leftover check (the driver reports the step as skipped) |
| cleanup | The driver deletes the tenants it created in tenant-identity's shared pool, each then 404; a tenant left fails the run |

Last green run: 2026-11-09, after the identity-provider change (two runs
on 2026-11-06, before it, were green too), in eu-central-1, a vendor test
account plus a second account owning tenant B's key: 53 to 65 minutes end
to end (the four integration runs of 2026-11-09; the last two, with step
10b, 179 checks each). The run's cleanup step deleted the
three tenants it had created in the shared tenant-identity pool.
CloudFormation
took about 4 minutes to create the two stacks (test aid 1 min 10 s, demo stack
2 min 17 s) and about 5 minutes to delete them (demo stack 3 min 9 s, test aid
1 min 35 s), so N-4 holds; the rest is the driver's waits. Every step passed
(`architecture.md` status block). The driver waits five minutes after each
key policy or tag change and on URL TTLs, leases and the sweep. The spec's cost target is under $2 per run; the cost of a run has
not been measured. Not covered by that run: no access log arrived within
three minutes for the `Requester` check, `kmsRequests` against CloudTrail is
recorded rather than checked, and offboarding saw 409 from the handler, not
403 from API Gateway ([§14](./architecture.md#14-known-gaps-and-residuals)).

## End-to-end demo

[`scripts/demo.sh`](./scripts/demo.sh) walks the delivery flow against a
deployed demo stack. It reads the published `apiUrl` and `bucketName`, calls
`/platform/*` with the ambient credentials (SigV4) and `/tenant/*` with an
access token it reads from a file and never prints. It does not create the
tenant or the token: bring a tenant-identity tenant entitled to both scopes
and a token for one of its users.

```bash
export AWS_REGION=eu-central-1
DEMO_TENANT=<tenantId> DEMO_TOKEN_FILE=<file with an access token> scripts/demo.sh
```

| Step | Call | Expect |
|---|---|---|
| 1 | `CreateTenantKey` for `DEMO_TENANT`, `vendor-key` | 201 and `keyStatus` `ACTIVE`; on 409 (the key exists) `GetTenantKey` 200 and `ACTIVE` |
| 2 | `CreateDelivery` for a synthetic 2-page PDF, the PUT with the returned headers, then `GetDelivery` every 5 s until terminal | 201, 200, then `ACCEPTED` |
| 3 | The same with a 5-page PDF | `REJECTED` with reason `pdf-pages:TOO_MANY_PAGES` (page limit 3) |
| Exit | `DeleteTenantKey`, when this run created the key or `DEMO_OFFBOARD=1`; skipped with `KEEP=1` | 202 |

The script checks every response against the table and exits non-zero on
the first mismatch, including a delivery not terminal after three minutes
of polling. Its EXIT trap runs also on failure: when this run created the
tenant key, or `DEMO_OFFBOARD=1` is set, it calls `DeleteTenantKey`, which
deletes the tenant's objects under both prefixes, the two deliveries
included, and schedules the key for deletion; a key that existed before the
run is left alone and the trap names the deliveries it leaves. `KEEP=1`
keeps everything for inspection. Last run 2026-11-06 in eu-central-1 against
a freshly deployed demo stack: every step as in the table, `DeleteTenantKey`
202 from the trap. That run predates the identity-provider change of
2026-11-09, which the integration run of 2026-11-09 covers. Tokens live five
minutes, so issue one just before the run.

## API

Two Smithy services in [`model/`](./model/): `IngestionPlatformService`
with the resource `TenantKey` under `/platform` (`AWS_IAM`), and
`IngestionTenantService` with the resource `Delivery` under `/tenant` (the
token authoriser plus a per-route scope check in the handler). REST,
Regional, stage `v1`, stage throttle 100 rps with burst 200, authoriser
cache 300 s ([`architecture.md` §8](./architecture.md#8-api)).

| Operation | Route | Statuses |
|---|---|---|
| `CreateTenantKey` | `POST /platform/tenants/{tenantId}/key` `{tier, keyArn?}` | 201; 409 key row or binding exists; 422 `KeyNotUsable`; 400 `UnsupportedInDeployment` (`tenant-key` without `allowTenantKeys`) |
| `GetTenantKey` | `GET /platform/tenants/{tenantId}/key` | 200, `keyStatus` refreshed by a probe; 404 |
| `RotateTenantKey` | `POST /platform/tenants/{tenantId}/key/rotate` | 200 `vendor-key`; 404 no key; 400 `UnsupportedInTier` for `tenant-key`; 409 not `ACTIVE`, rotation in progress, or a `Conflict` whose message starts `RotationLimitReached` |
| `DeleteTenantKey` | `DELETE /platform/tenants/{tenantId}/key` | 202; 204 when there is no key. Idempotent: a half-done call is finished by repeating it |
| `CreateDelivery` | `POST /tenant/deliveries` `{fileName, contentType, sizeBytes}`, scope `ingestion/deliver` | 201 `{deliveryId, uploadUrl, headers, expiresAt}`; 400; 403 `Forbidden` without the scope; 409 `TenantKeyUnavailable` (key missing or not `ACTIVE`); 429 `TooManyDeliveries` |
| `GetDelivery` | `GET /tenant/deliveries/{deliveryId}`, scope `ingestion/read` | 200; 404 outside the caller's tenant |
| `ListDeliveries` | `GET /tenant/deliveries?status=&nextToken=`, scope `ingestion/read` | 200, newest first, 50 per page; `nextToken` must name the caller's partition |

A `/tenant/*` request without a valid token is 401 from the authoriser; with
`tenantThrottle` set, API Gateway throttles each tenant on its own usage-plan
key.

Delivery status machine:

```text
AWAITING_UPLOAD -> PROCESSING -> ACCEPTED | REJECTED | KEY_UNAVAILABLE
AWAITING_UPLOAD -> EXPIRED            (no upload before urlExpiresAt + abandonGraceSeconds; no event)
```

`PROCESSING` is a lease (`leaseOwner`, `leaseUntil`). `reason` is
`structural:<CODE>` (`TYPE_MISMATCH`, `SIZE_MISMATCH`, `TOO_LARGE`,
`KEY_MISMATCH`, `STORAGE_CLASS`, `OBJECT_CHANGED`, `PROCESSING_ABANDONED`,
...), `<validator>:<CODE>` (`<validator>:VALIDATOR_ERROR` for a validator
that errs on the last receive) or the KMS error for `KEY_UNAVAILABLE`. Key
status: `CREATING -> ACTIVE <-> REVOKED`, and `-> DELETING`.

**Errors.** Every error is `{code, message, requestId}`. The table shows
the `code` field: the error shape's name without its `Error` suffix
(`ValidationError` and `InternalError` keep the full name). A message never
echoes the input, a tenant id or a key ARN
([`src/api/errors.ts`](./src/api/errors.ts), ADR-0022).

| Status | Code |
|---|---|
| 400 | `ValidationError`, `UnsupportedInTier`, `UnsupportedInDeployment` |
| 403 | `Forbidden` (the route's scope is missing) |
| 404 | `NotFound` |
| 409 | `Conflict`, `TenantKeyUnavailable` |
| 422 | `KeyNotUsable` |
| 429 | `TooManyDeliveries` |
| 500 | `InternalError` |

**Events** on the construct's bus, `source: tenant-encrypted-ingestion`,
detail `{tenantId, deliveryId, landedKey?, sizeBytes?, contentType?,
reason?}`: no file name, key ARN or URL. Delivery is at least once, so
consumers de-duplicate on `deliveryId`, and the bus is vendor-side, so
consumers filter on `detail.tenantId`.

| `detail-type` | When |
|---|---|
| `DeliveryAccepted` | the document landed at `landedKey` under `documents/<tenantId>/` |
| `DeliveryRejected` | a structural check or a validator rejected it, a validator erred on the last receive, or the sweep abandoned the lease |
| `DeliveryKeyUnavailable` | the probe showed the tenant's key unusable; the tenant is `REVOKED` until a probe succeeds |

## Costs

Everything but the keys is pooled, so the bill carries a tenant tag only on
`vendor-key` keys; the rest is metered per tenant by the component that
knows the tenant ([`architecture.md` §11](./architecture.md#11-observability-and-per-tenant-cost-attribution)).

- **Idle tenant**: $1 per month for a `vendor-key` tenant (the key-month,
  tagged `TenantId`, so it splits by tenant once the tag is activated as a
  cost allocation tag); $0 for a `tenant-key` tenant, whose key bills to its
  own account (spec N-5). Under current KMS pricing the first two rotations
  of a key's material each add $1 per month to that key; check the KMS
  pricing page for your Region.
- **KMS requests per delivery**, as metered into the key row's `kmsRequests`:
  four plus one per validator for an accepted delivery (the PUT, the
  structural read, one per validator GET, two for the copy;
  [`src/shared/metering.ts`](./src/shared/metering.ts)). With the demo's two
  validators the processor meters 6. CloudTrail held 19 KMS events for the
  processor session of that delivery; the breakdown has not been done (the
  probe and S3's own retries are candidates), so treat `kmsRequests` as a
  lower bound until the reconciliation is done. `tenant-key` requests count
  against the vendor's KMS quota and bill to the tenant's account.
- **S3 storage**: `bytesStored` per tenant for landed documents, plus
  noncurrent versions of `documents/` kept 7 days after an overwrite or
  delete. Drops are deleted once processed; noncurrent drop versions expire
  after 1 day and unprocessed drops after `dropRetentionDays`.
- **Per delivery**: Lambda, SQS, EventBridge and DynamoDB scale with
  `deliveriesAccepted` plus `deliveriesRejected`; API Gateway with the
  tenant's `/tenant` requests (a Contributor Insights rule ranks them,
  `/tenant/deliveries` and `/tenant/deliveries/{deliveryId}` both).
- **The integration test**: 53 to 65 minutes per run; the spec's target is
  under $2 per run, and a run's cost has not been measured.

Attribution formula:

    cost(tenant) = key-month (vendor-key only, from the TenantId tag)
                 + bytesStored × S3 GB-month
                 + kmsRequests × KMS request price   (pending reconciliation)
                 + deliveries × (Lambda + SQS + EventBridge + DynamoDB per delivery)
                 + /tenant requests × API Gateway request price
                 + share of the unattributable remainder

**Unattributable remainder**: the sweep, the registry watch, the Contributor
Insights rules, log storage, the access-log bucket and the noncurrent-version
storage of drops. Apportion it by deliveries. `perTenantMetrics` adds EMF
metrics with a `TenantId` dimension, one custom metric set per tenant, so it
is off by default.

## Security notes

- **Identity model.** The tenant comes only from the verified `tenant_id`
  claim on `/tenant/*`, or from the object key's second segment in the
  pipeline, checked against the tenant-id grammar before any `AssumeRole`.
  Three tenant roles (`tenantUploadRole`, `tenantProcessRole`,
  `tenantPlatformRole`) are assumed with a `TenantId` session tag and carry
  every call made for a tenant; seven base roles, one per function
  (authoriser, API, processor, key factory, platform, sweep, registry
  watch), reach no document and may each assume exactly one tenant role or
  none. Session names are `t-<tenantId>-...`, so CloudTrail and S3 access
  logs name the tenant.
- **Two walls.** The key policy admits only the tenant roles and consumer
  roles, via S3, on the tenant's own prefixes; the tenant roles' identity
  policies scope S3, KMS and the registry to the session tag. Each is proven
  alone by integ steps 5 and 6.
- **Trust boundaries** (threat model): B1 tenant to the API (token and
  scope, IAM on `/platform/*`, per-tenant limits); B2 the upload to the
  bucket (signed headers, bucket policy, structural checks); B3 vendor code
  to a tenant session (trust policies, ABAC); B4 S3 to KMS (key policy,
  Bucket Keys off); B5 vendor account to tenant account (`tenant-key`
  admission and the probe); B6 processor to validator (invoke grant, pinned
  single-object URL, verdict schema); B7 vendor administration of keys,
  registry and bucket; B8 pipeline to consumers (bus and consumer roles); B9
  telemetry, queues, backups and parameters; B10 the integration runner.
- cdk-nag `AwsSolutionsChecks` runs on every synth; each suppression cites
  an ADR or a mitigation.

Residuals the threat model accepts
([accepted risks](./threat-model.md#accepted-risks)):

- Compromised function code acts as one tenant per session: the trust
  policies fix the tag key, not which tenant it names. A wrong-tenant bug is
  refused by AWS; deliberate compromise is bounded by one tenant role per
  function and visible in CloudTrail.
- An IAM administrator in the vendor account can `PutKeyPolicy` first
  (statement 3 keeps every key manageable) and then read; the call is
  alarmed (M-25).
- A compromised key factory can bind a **new** tenant to a key it chose;
  a changed binding of an existing tenant alarms through the registry watch,
  a new one does not.
- PITR keeps an offboarded tenant's file names and hashes, never content,
  for 35 days.
- S3 access logs record presigned URIs; they go to a separate bucket that
  only `accessLogReaderRole` may read.
- The `inFlight` counter is filtered against code: compromised code under a
  tenant role can reset its own tenant's counter. The sweep reconciles it
  hourly.
- The event bus is vendor-side and filtered: any rule in the vendor account
  sees every tenant's `Delivery*` events (no file names, ARNs or URLs).
- By design, S3, the processor and every validator see the document in
  plaintext behind TLS (server-side encryption).

Threats, mitigations and the full list: [`threat-model.md`](./threat-model.md).

Facts verified on AWS (spikes on 2026-11-05 and the run of 2026-11-06):

- S3 asks KMS for the data key before it evaluates the bucket policy, so a
  PUT naming a tenant key by a principal the key policy does not admit is
  refused by KMS; the principal-scoped bucket Deny is observed only with
  another key such as `aws/s3` (step 5).
- A broken key is a 400 from S3, not a 403: `KMS.DisabledException` for a
  disabled key, `KMS.KMSInvalidStateException` for a key pending deletion; a
  removed key-policy statement is 403 `AccessDenied` (steps 8 and 11). The
  probe runs on any S3 error that is a 403 or names KMS.
- Lambda decrypts a function's environment variables with `kms:Decrypt`
  under the execution role, so the base roles' KMS use Deny is scoped to keys
  tagged `TenantId`; an unconditioned Deny stops the function at init with
  no log line.
- `aws:ResourceTag/TenantId` evaluates on a KMS key in another account, for
  a direct `DescribeKey` and for S3-initiated use, in both directions (step
  1 repeats it on every run).
- `CreateKey` with tags is not blocked by the new key's Deny-tagging
  statement; a later `TagResource` is.

## Production hardening checklist

Each item is a deployer action in [`threat-model.md`](./threat-model.md#mitigations)
(M-n), an [accepted risk](./threat-model.md#accepted-risks) or a gap in
[`architecture.md` §14](./architecture.md#14-known-gaps-and-residuals).

- [ ] **Use a real second account for each `tenant-key` tenant**, and keep
      the admission checks (M-19). Cross-account `aws:ResourceTag` is
      verified, not documented; integ step 1 re-proves it on every run with
      `TEI_TENANT_KEY_PROFILE` (accepted risk 5).
- [ ] **Turn on a CloudTrail trail delivering management events to
      EventBridge** in the vendor account, or the `PutKeyPolicy` alarm never
      fires, and route the alarm to someone who answers it (M-25, accepted
      risk 4).
- [ ] **Decide the consumer roles before the first tenant.** They are fixed
      into each key's policy at creation; changing them is a bulk
      `PutKeyPolicy` over every key, which the sample does not build. Write
      the runbook and expect the alarm to fire for each key (M-25).
- [ ] **Reconcile `kmsRequests` with CloudTrail before billing on it**: the
      run metered 6 KMS requests for a delivery CloudTrail counted 19 for
      (M-28).
- [ ] **Set `accessLogReaderRole`** to the one principal that may read
      server access logs, which hold presigned query strings (M-27, accepted
      risk 6).
- [ ] **Enforce validator timeouts yourself.** The processor does not abort
      a validator at its declared timeout; a validator that hangs makes the
      processor time out and the sweep abandons the lease. Set each
      validator function's own timeout at or below what it declares (M-11,
      M-21).
- [ ] **Size the per-tenant limits.** Size `maxInFlightPerTenant` so
      tenants × in-flight stays under the STS `AssumeRole` limit of 600 rps
      per account. With `tenantThrottle`, API
      Gateway allows 10,000 API keys per account and Region, not adjustable
      and shared with tenant-identity's per-tenant keys, so a composed
      deployment caps at 5,000 tenants, and `CreateApiKey` at 5 rps bounds
      bulk onboarding (M-5, spec N-3, N-4).
- [ ] **Budget for versioning.** Landed documents keep noncurrent versions
      for 7 days, so an overwritten or deleted document is billed and
      recoverable for a week (M-8).
- [ ] **Move long validators to a Step Functions carrier.** T (60 s + the
      validator timeouts + 60 s) must fit in the 15-minute Lambda limit;
      the carrier is a spec §11 seam (M-11).
- [ ] **Restrict `ssm:PutParameter` and `DeleteParameter` on
      `/application-plane/shared/ingestion/*`** to the deployment role, so
      nobody can repoint a consumer (M-30).
- [ ] **Consider alias-bound keys and a per-tenant bus subscription**, the
      spec §11 hardening seams for the key-factory and event-bus residuals
      (accepted risks 3 and 12).
- [ ] **Keep your dependencies and function code reviewed**: compromised
      code acts as one tenant per session (accepted risk 2).
- [ ] **If you bring your own issuer, you own `tenant_id` uniqueness and the
      two scopes.** With `identityApi: 'none'` your provider issues one
      `tenant_id` per token, never reused across tenants, and defines
      `ingestion/deliver` and `ingestion/read`; that path is covered by unit
      tests only (T-39, ADR-0019, accepted risk 13).
- [ ] **Restrict who can run code as the scope registration.** Its role can
      put or delete any scope in tenant-identity's catalogue; limit
      `lambda:InvokeFunction` and `lambda:UpdateFunctionCode` on the
      function to the deployment role (T-38, M-34, accepted risk 14).
- [ ] **Keep `uploadUrlTtlSeconds` short.** Once the processor deletes a
      drop, its PUT URL can write again until the TTL; the processor
      discards that upload at the cost of one run (accepted risk 7).
- [ ] **Tell tenants what offboarding keeps.** PITR keeps an offboarded
      tenant's file names and hashes, never content, for 35 days (accepted
      risk 8).
- [ ] **Watch the KMS key quota.** Keys pending deletion count against the
      100,000-key quota for `keyDeletionWindowDays` after `DeleteTenantKey`
      or a destroy; size the window to your offboarding rate (accepted risk
      9).
- [ ] **Restrict who may read the queue and its DLQ.** S3 events carry the
      uploader's IP address and requester, and the DLQ holds them up to 14
      days (accepted risk 10).
- [ ] **Set `tenantThrottle` at scale.** Compromised code under a tenant
      role can reset its own tenant's `inFlight` counter; the sweep
      reconciles it hourly and API Gateway enforces `tenantThrottle`
      regardless (accepted risk 11).
- [ ] **Change the removal policies.** The sample sets `DESTROY` on every
      resource so teardown is total; keep the bucket, registry and log
      groups in a deployment that holds tenant data (M-31).

## Design trail

- Specification: [`design/tenant-encrypted-ingestion.spec.md`](./design/tenant-encrypted-ingestion.spec.md)
- Decisions: [`adr/`](./adr/) (indexed in [`adr/README.md`](./adr/README.md))
- Implemented state: [`architecture.md`](./architecture.md)
- Threats and mitigations: [`threat-model.md`](./threat-model.md)
- Diagram sources: [`diagrams/tenant-encrypted-ingestion.components.drawio`](./diagrams/tenant-encrypted-ingestion.components.drawio)
  and [`diagrams/tenant-encrypted-ingestion.drawio`](./diagrams/tenant-encrypted-ingestion.drawio)

Three independent blind reviews of the specification, ADRs and threat model
ran before any code was written, and every finding was adopted
([threat model, appendix A](./threat-model.md#appendix-a-review-history)).
