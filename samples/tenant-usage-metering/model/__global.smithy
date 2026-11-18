// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

$version: "2.0"

// Operation names use the AWS lifecycle verbs plus `Start`, for the jobs of
// spec §4.6 (docs/sample-standard.md §4.2). DANGER makes a bad name fail
// `smithy build`.
metadata validators = [
    {
        name: "StandardOperationVerb"
        severity: "DANGER"
        configuration: {
            verbs: ["Create", "Get", "Update", "Delete", "List", "Put", "Start"]
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

metadata suppressions = [
    {
        id: "MemberShouldReferenceResource"
        namespace: "tenantusagemetering"
        reason: "Tenant, application and meter ids name records across several resources; a @references to one of them would mislead codegen."
    }
    {
        id: "ServiceBoundResourceOperation"
        namespace: "tenantusagemetering"
        reason: "Usage reads and jobs span resources (spec §5); they are service operations on purpose."
    }
]

namespace tenantusagemetering

// ---------------------------------------------------------------------------
// Identifiers (spec §4)
// ---------------------------------------------------------------------------

/// A tenant id. The control plane's are ULIDs; another registrar may use
/// any id in this charset. Ids are case-sensitive: the binding key is the
/// exact string (spec §4.3).
@pattern("^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
@length(min: 1, max: 64)
string TenantId

/// An application id (control-plane §4.1).
@pattern("^[a-z0-9-]{1,32}$")
@length(min: 1, max: 32)
string ApplicationId

/// A cell id: a ULID (control-plane §4.2).
@pattern("^[0-9A-HJKMNP-TV-Z]{26}$")
string CellId

/// A 12-digit AWS account id.
@pattern("^[0-9]{12}$")
string AccountId

/// A meter id (spec §4.1).
@pattern("^[a-z0-9_.-]{1,64}$")
@length(min: 1, max: 64)
string MeterId

/// A sink id.
@pattern("^[a-z0-9-]{1,32}$")
@length(min: 1, max: 32)
string SinkId


/// A job id: a ULID.
@pattern("^[0-9A-HJKMNP-TV-Z]{26}$")
string JobId

/// An hour: `YYYY-MM-DDTHH`, UTC.
@pattern("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}$")
string Hour


/// A quantity in a usage record; an ADJUSTMENT may be negative (spec §4.7).
/// Up to 24 integer digits: a SUM of 12-digit values over an hour.
@pattern("^-?[0-9]{1,24}(\\.[0-9]{1,6})?$")
string Quantity

/// The tenant's account id in the billing system (spec §3.4).
@pattern("^[A-Za-z0-9._:-]{1,128}$")
string BillingAccount

/// ISO 8601 timestamp.
@timestampFormat("date-time")
timestamp IsoTimestamp

/// Opaque pagination token.
@length(min: 1, max: 4096)
string PaginationToken

@range(min: 1, max: 100)
integer PageSize

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/// How a meter sums its events (spec §4.1).
enum SumRule {
    COUNT
    SUM
    MAX
    UNIQUE_COUNT
}

enum MeterStatus {
    ACTIVE
    RETIRED
}

enum RegistrationStatus {
    ACTIVE
    CLOSING
}

enum SinkType {
    HTTP
    S3_EXPORT
}

enum HourStatus {
    OPEN
    COUNTING
    COUNTED
    DIRTY
    COUNT_FAILED
    CLOSED
}

enum JobKind {
    RECOUNT
    READMIT
    INGEST_REDRIVE
    SINK_REDRIVE
    RESEND_BLOCKED
}

enum JobStatus {
    RUNNING
    SUCCEEDED
    FAILED
}

enum RecordKind {
    HOURLY
    ADJUSTMENT
}

enum DeliveryStatus {
    PENDING
    RETRYING
    SENT
    BLOCKED
    FAILED
}

/// The result of one event in `PutUsageEvents` (spec §5).
enum EventResult {
    ACCEPTED
    RETRY
    REFUSED
}

/// The refusals that could still count, which `StartReadmission` may
/// select (spec P-8).
enum ReadmittableReason {
    TENANT_NOT_IN_CELL
    REGISTRATION_CLOSED
    UNKNOWN_METER
    METER_NOT_ALLOWED
}

/// Why a 409 was returned. Only `CONCURRENT_WRITE` is worth retrying.
enum ConflictReason {
    /// `PutCellEmitter` in a subscriber account or the metering account.
    ACCOUNT_NOT_ALLOWED

    /// `CreateMeter` or `CreateSink` on an existing id.
    ALREADY_EXISTS

    /// A known cell with another account or application, or a binding for
    /// a cell with no emitter or of another application (spec §4.2, §4.3).
    PLACEMENT_MISMATCH

    /// `StartRecount` whose whole range is closed or within 60 minutes of
    /// its close.
    RANGE_CLOSED

    /// A lost conditional write: retry.
    CONCURRENT_WRITE
}

/// Why an event was refused (spec §5). The first four can be re-admitted.
enum RefusalReason {
    TENANT_NOT_IN_CELL
    REGISTRATION_CLOSED
    UNKNOWN_METER
    METER_NOT_ALLOWED
    BAD_TIME
    TOO_LATE
    BAD_SHAPE
}

// ---------------------------------------------------------------------------
// Errors (spec §5)
// ---------------------------------------------------------------------------

/// A semantic refusal the model cannot express (e.g. a backdated
/// `effectiveFrom` beyond the window, a `secretName` outside its prefix).
@error("client")
@httpError(400)
structure ValidationError {
    @required
    message: String
}

@error("client")
@httpError(403)
structure AccessDeniedException {
    @required
    message: String
}

@error("client")
@httpError(404)
structure ResourceNotFoundException {
    @required
    message: String
}

/// A refused account, an existing id, a placement mismatch, a closed range,
/// or a lost conditional write; only the last is retryable (`reason`).
@error("client")
@httpError(409)
structure ConflictException {
    @required
    message: String

    @required
    reason: ConflictReason
}

/// A `PutUsageEvents` body over 1,048,576 bytes of UTF-8, measured in bytes
/// (spec §5.1). Not resent: split it.
@error("client")
@httpError(413)
structure PayloadTooLargeException {
    @required
    message: String
}

@error("client")
@httpError(429)
structure ThrottlingException {
    @required
    message: String
}

@error("server")
@httpError(500)
structure InternalServerError {
    @required
    message: String
}
