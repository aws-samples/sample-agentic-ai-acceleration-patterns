// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

$version: "2.0"

// Operation names use the AWS lifecycle verbs plus `Rotate`, the one
// non-lifecycle verb this sample needs (RotateTenantKey, spec §5.1;
// docs/sample-standard.md §4.2). DANGER makes a bad name fail `smithy build`.
metadata validators = [
    {
        name: "StandardOperationVerb"
        severity: "DANGER"
        configuration: {
            verbs: ["Create", "Get", "Update", "Delete", "List", "Put", "Rotate"]
            suggestAlternatives: {
                Read: ["Get"]
                Fetch: ["Get"]
                Describe: ["Get"]
                Add: ["Create"]
                Remove: ["Delete"]
            }
        }
    }
]

namespace tenantencryptedingestion

// ---------------------------------------------------------------------------
// Common types
// ---------------------------------------------------------------------------

/// A tenant id (spec §7.0). Keeps `/` out, so `ingest/${tag}/*` never nests
/// one tenant in another, and keeps session names under 64 characters.
@pattern("^[A-Za-z0-9][A-Za-z0-9-]{1,34}$")
@length(min: 2, max: 35)
string TenantId

/// A delivery id: a ULID, so `DELIVERY#<id>` sorts newest last and a
/// descending query lists newest first (spec §4.2).
@pattern("^[0-9A-HJKMNP-TV-Z]{26}$")
string DeliveryId

/// The tenant's name for the file (M-3). Lives on the row and in a quoted
/// `Content-Disposition` only; never in an object key, a log or an event.
@pattern("^[A-Za-z0-9._-]{1,128}$")
@length(min: 1, max: 128)
string FileName

/// A declared media type. The deployment's allowlist (`allowedContentTypes`)
/// is checked by the handler; the model only bounds the shape.
@pattern("^[a-z]+/[a-z0-9.+-]+$")
@length(min: 3, max: 127)
string ContentType

/// A declared object size in bytes.
@range(min: 1)
long SizeBytes

/// A KMS key ARN as the caller supplies it. Only its length is checked
/// here: a malformed, alias or other-Region ARN is a 422 KeyNotUsable from
/// the handler (M-19), not a 400.
@length(min: 1, max: 2048)
string KeyArnInput

/// ISO 8601 timestamp.
@timestampFormat("date-time")
timestamp IsoTimestamp

/// Opaque pagination token.
@length(min: 1, max: 4096)
string PaginationToken

/// The key tier of a tenant (spec P-4).
enum KeyTier {
    VENDOR_KEY = "vendor-key"
    TENANT_KEY = "tenant-key"
}

/// The key row's status (spec §4.1).
enum KeyStatus {
    CREATING
    ACTIVE
    REVOKED
    DELETING
}

/// The delivery row's status (spec §4.2).
enum DeliveryStatus {
    AWAITING_UPLOAD
    PROCESSING
    ACCEPTED
    REJECTED
    KEY_UNAVAILABLE
    EXPIRED
}

// ---------------------------------------------------------------------------
// Errors (spec §5.3). The Lambda wrappers render every error as
// `{code, message, requestId}`; the shape name maps to `code`
// (src/api/errors.ts).
// ---------------------------------------------------------------------------

/// Malformed input.
@error("client")
@httpError(400)
structure ValidationError {
    @required
    message: String
}

/// The operation has no meaning for the tenant's key tier.
@error("client")
@httpError(400)
structure UnsupportedInTierError {
    @required
    message: String
}

/// The operation needs an option the deployment does not enable.
@error("client")
@httpError(400)
structure UnsupportedInDeploymentError {
    @required
    message: String
}

/// The token lacks the scope the route needs (M-2).
@error("client")
@httpError(403)
structure ForbiddenError {
    @required
    message: String
}

/// Unknown resource, or one outside the caller's tenant.
@error("client")
@httpError(404)
structure NotFoundError {
    @required
    message: String
}

/// The request conflicts with current state.
@error("client")
@httpError(409)
structure ConflictError {
    @required
    message: String
}

/// The tenant's key row is missing or not ACTIVE.
@error("client")
@httpError(409)
structure TenantKeyUnavailableError {
    @required
    message: String
}

/// The key cannot be used by the pipeline (M-19).
@error("client")
@httpError(422)
structure KeyNotUsableError {
    @required
    message: String
}

/// The tenant holds `maxInFlightPerTenant` open deliveries (N-8).
@error("client")
@httpError(429)
structure TooManyDeliveriesError {
    @required
    message: String
}

/// An unexpected server-side failure.
@error("server")
@httpError(500)
structure InternalError {
    @required
    message: String
}
