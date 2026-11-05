// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

$version: "2.0"

namespace tenantencryptedingestion

use aws.protocols#restJson1
use smithy.framework#ValidationException

/// The tenant's door (spec §5.2). Every route is under `/tenant` and is
/// authorised by the token authoriser (M-1). The tenant is never in the
/// request: it is the verified `tenant_id` claim (M-2).
@title("Tenant Encrypted Ingestion - Tenant API")
@restJson1
@httpBearerAuth
service IngestionTenantService {
    version: "2026-11-05"
    resources: [
        Delivery
    ]
    errors: [
        ValidationException
        ValidationError
        ForbiddenError
        InternalError
    ]
}

/// One file a tenant delivers (spec §4.2).
resource Delivery {
    identifiers: {
        deliveryId: DeliveryId
    }
    create: CreateDelivery
    read: GetDelivery
    list: ListDeliveries
}

/// The six headers the upload must send, all of them signed (spec §7.5).
map UploadHeaders {
    key: String
    value: String
}

/// A presigned URL. Never logged (N-6).
@sensitive
string UploadUrl

/// One validator's outcome, in run order.
structure ValidatorOutcome {
    @required
    validator: String

    @required
    verdict: String

    code: String

    @required
    durationMs: Long
}

list ValidatorOutcomeList {
    member: ValidatorOutcome
}

/// A delivery as the caller's tenant sees it.
structure DeliverySummary {
    @required
    deliveryId: DeliveryId

    @required
    fileName: FileName

    @required
    contentType: ContentType

    @required
    sizeBytes: SizeBytes

    @required
    status: DeliveryStatus

    /// `structural:<CODE>`, `<validator>:<CODE>`, or the KMS error.
    reason: String

    /// The validator's message, if any. Never document content.
    reasonMessage: String

    /// `documents/<tenantId>/<deliveryId>` once ACCEPTED.
    landedKey: String

    sha256: String

    validators: ValidatorOutcomeList

    @required
    createdAt: IsoTimestamp

    @required
    updatedAt: IsoTimestamp
}

@length(max: 100)
list DeliveryList {
    member: DeliverySummary
}

/// Opens a delivery and returns a write-once presigned PUT for it (ADR-0006,
/// M-6). Needs `ingestion/deliver`.
@http(method: "POST", uri: "/tenant/deliveries", code: 201)
operation CreateDelivery {
    input := {
        @required
        fileName: FileName

        @required
        contentType: ContentType

        @required
        sizeBytes: SizeBytes
    }
    output := {
        @required
        deliveryId: DeliveryId

        @required
        uploadUrl: UploadUrl

        @required
        headers: UploadHeaders

        @required
        expiresAt: IsoTimestamp
    }
    errors: [
        TenantKeyUnavailableError
        TooManyDeliveriesError
    ]
}

/// One of the caller's tenant's deliveries. Needs `ingestion/read`.
@readonly
@http(method: "GET", uri: "/tenant/deliveries/{deliveryId}")
operation GetDelivery {
    input := {
        @required
        @httpLabel
        deliveryId: DeliveryId
    }
    output := {
        @required
        delivery: DeliverySummary
    }
    errors: [
        NotFoundError
    ]
}

/// The caller's tenant's deliveries, newest first. Needs `ingestion/read`.
@readonly
@paginated(inputToken: "nextToken", outputToken: "nextToken", items: "deliveries")
@http(method: "GET", uri: "/tenant/deliveries")
operation ListDeliveries {
    input := {
        @httpQuery("status")
        status: DeliveryStatus

        @httpQuery("nextToken")
        nextToken: PaginationToken
    }
    output := {
        @required
        deliveries: DeliveryList

        nextToken: PaginationToken
    }
}
