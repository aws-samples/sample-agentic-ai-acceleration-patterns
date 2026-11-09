// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

$version: "2.0"

namespace tenantencryptedingestion

use aws.auth#sigv4
use aws.protocols#restJson1
use smithy.framework#ValidationException

/// The vendor's door (spec §5.1). Every route is under `/platform` and is
/// authorised by IAM (SigV4, M-4). The tenant is named in the path.
@title("Tenant Encrypted Ingestion - Platform API")
@restJson1
@sigv4(name: "execute-api")
service IngestionPlatformService {
    version: "2026-11-05"
    resources: [
        TenantKey
    ]
    errors: [
        ValidationException
        ValidationError
        InternalError
    ]
}

/// A tenant's KMS key binding (spec §4.1). One per tenant.
resource TenantKey {
    identifiers: {
        tenantId: TenantId
    }
    read: GetTenantKey
    delete: DeleteTenantKey
    operations: [
        CreateTenantKey
        RotateTenantKey
    ]
}

/// A tenant's key as the registry holds it. `keyArn` is the canonical ARN.
structure TenantKeySummary {
    @required
    tenantId: TenantId

    @required
    tier: KeyTier

    @required
    keyArn: String

    /// `vendor-key` only: `alias/tenant-<tenantId>-ingestion`.
    keyAlias: String

    @required
    keyStatus: KeyStatus

    @required
    inFlight: Long

    @required
    bytesStored: Long

    @required
    deliveriesAccepted: Long

    @required
    deliveriesRejected: Long

    @required
    kmsRequests: Long

    @required
    createdAt: IsoTimestamp

    @required
    updatedAt: IsoTimestamp

    lastKeyCheckAt: IsoTimestamp
}

/// Binds a key to the tenant (ADR-0001, ADR-0004). `vendor-key`: a new key
/// with the §7.2 policy, tags, alias and rotation. `tenant-key`: the tenant's
/// own key, admitted by `DescribeKey` under a tenant session and a probe
/// through S3. Runs under `keyFactoryRole`.
@http(method: "POST", uri: "/platform/tenants/{tenantId}/key", code: 201)
operation CreateTenantKey {
    input := {
        @required
        @httpLabel
        tenantId: TenantId

        @required
        tier: KeyTier

        /// `tenant-key` only: the key in the tenant's account.
        keyArn: KeyArnInput
    }
    output := {
        @required
        key: TenantKeySummary
    }
    errors: [
        UnsupportedInDeploymentError
        ConflictError
        KeyNotUsableError
    ]
}

/// The tenant's key, with `keyStatus` refreshed by a probe through S3
/// (M-18): `DescribeKey` cannot tell a removed use statement from a healthy key.
@readonly
@http(method: "GET", uri: "/platform/tenants/{tenantId}/key")
operation GetTenantKey {
    input := {
        @required
        @httpLabel
        tenantId: TenantId
    }
    output := {
        @required
        key: TenantKeySummary
    }
    errors: [
        NotFoundError
    ]
}

/// `vendor-key`: rotates the key material on demand. `tenant-key`:
/// UnsupportedInTier. A key past its on-demand rotation quota is a 409
/// whose message starts `RotationLimitReached`.
@http(method: "POST", uri: "/platform/tenants/{tenantId}/key/rotate", code: 200)
operation RotateTenantKey {
    input := {
        @required
        @httpLabel
        tenantId: TenantId
    }
    output := {
        @required
        tenantId: TenantId

        @required
        rotationStarted: Boolean
    }
    errors: [
        NotFoundError
        UnsupportedInTierError
        ConflictError
    ]
}

/// Offboards the tenant cryptographically (ADR-0005, M-26): every version
/// under both prefixes, the API key, the alias, the key scheduled for
/// deletion (`vendor-key`), the row and `KEYARN#`. 202 when something was
/// removed, 204 when there was nothing to remove, so a half-done call is
/// resumed by repeating it.
@idempotent
@http(method: "DELETE", uri: "/platform/tenants/{tenantId}/key", code: 202)
operation DeleteTenantKey {
    input := {
        @required
        @httpLabel
        tenantId: TenantId
    }
    output := {
        @httpResponseCode
        statusCode: Integer
    }
}
