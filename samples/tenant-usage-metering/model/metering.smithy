// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

$version: "2.0"

namespace tenantusagemetering

use aws.auth#sigv4
use aws.protocols#restJson1
use smithy.framework#ValidationException

/// The tenant usage metering service (spec §5). Every operation is
/// IAM-authorised; which principals may call which route is the API's
/// resource policy (spec §3.2).
@restJson1
@sigv4(name: "execute-api")
service TenantUsageMeteringService {
    version: "2026-11-18"
    operations: [
        PutUsageEvents
        GetUsage
        ListUsage
        StartRecount
        StartReadmission
        StartIngestRedrive
        StartSinkRedrive
        StartResendBlocked
    ]
    resources: [
        Meter
        Sink
        CellEmitter
        TenantBinding
        MeteringHour
        Job
    ]
    errors: [
        ValidationException
        ValidationError
        ConflictException
        AccessDeniedException
        ThrottlingException
        InternalServerError
    ]
}

// ---------------------------------------------------------------------------
// Usage events (spec §4.8, §5)
// ---------------------------------------------------------------------------

/// One usage event (spec §4.8). The members are deliberately unconstrained
/// here: the function checks each event and refuses a bad one alone, as
/// `BAD_SHAPE` or `BAD_TIME` (spec P-8), so one bad event never fails its
/// batch. The rules it applies:
/// - `eventId`: a ULID or a lowercase UUID, reused on every resend;
/// - `tenantId`: a tenant bound to the caller's cell;
/// - `meterId`: `[a-z0-9_.-]{1,64}`, a meter in effect at the event's hour;
/// - `value`: a non-negative decimal, at most 12 integer and 6 fractional
///   digits; `COUNT` ignores it, `UNIQUE_COUNT` treats it as a string;
/// - `time`: ISO 8601 UTC with `Z`, kept as the emitter sent it;
/// - `dimensions`: at most 10 keys `[A-Za-z0-9_.-]{1,64}`, values up to 256
///   characters, no personal data (spec §6.1).
/// The service adds the emitter's identity; a body field never names it
/// (spec P-2).
structure UsageEvent {
    eventId: String

    tenantId: String

    meterId: String

    value: String

    time: String

    dimensions: Dimensions
}

map Dimensions {
    key: String
    value: String
}

@length(min: 1, max: 100)
list UsageEventList {
    member: UsageEvent
}

structure UsageEventResult {
    @required
    eventId: String

    @required
    result: EventResult

    reason: RefusalReason
}

list UsageEventResultList {
    member: UsageEventResult
}

/// Sends up to 100 usage events from a registered emitter. 200 with one
/// result per event; a caller that is not a registered emitter gets 403.
@http(method: "POST", uri: "/usage-events", code: 200)
operation PutUsageEvents {
    input := {
        @required
        events: UsageEventList
    }
    output := {
        @required
        results: UsageEventResultList
    }
}

// ---------------------------------------------------------------------------
// Meters (spec §4.1, ADR-0004)
// ---------------------------------------------------------------------------

resource Meter {
    identifiers: {
        meterId: MeterId
    }
    read: GetMeter
    update: UpdateMeter
    delete: DeleteMeter
    list: ListMeters
    operations: [
        CreateMeter
    ]
}

@length(max: 100)
list ApplicationIdList {
    member: ApplicationId
}

structure MeterVersion {
    @required
    meterId: MeterId

    @required
    version: Integer

    @required
    unit: MeterUnit

    @required
    rule: SumRule

    allowedApplications: ApplicationIdList

    @required
    effectiveFrom: Hour

    @required
    status: MeterStatus

    @required
    createdBy: String

    @required
    createdAt: IsoTimestamp
}

@length(min: 1, max: 32)
string MeterUnit

list MeterVersionList {
    member: MeterVersion
}

/// Creates a meter. `effectiveFrom` defaults to the next whole hour and may
/// name an earlier one inside the recount window (spec §4.1). Not
/// idempotent: a repeat is a 409 `ALREADY_EXISTS`.
@http(method: "POST", uri: "/meters", code: 201)
operation CreateMeter {
    input := {
        @required
        meterId: MeterId

        @required
        unit: MeterUnit

        @required
        rule: SumRule

        allowedApplications: ApplicationIdList

        effectiveFrom: Hour
    }
    output := {
        @required
        meter: MeterVersion
    }
    errors: [
        ConflictException
    ]
}

/// The current version; with `versions=ALL`, every version too.
@readonly
@http(method: "GET", uri: "/meters/{meterId}")
operation GetMeter {
    input := {
        @required
        @httpLabel
        meterId: MeterId

        @httpQuery("versions")
        versions: MeterVersionsView
    }
    output := {
        @required
        meter: MeterVersion

        versions: MeterVersionList
    }
    errors: [
        ResourceNotFoundException
    ]
}

enum MeterVersionsView {
    CURRENT
    ALL
}

/// Writes a new version that counts from the next whole hour (spec P-6).
/// An absent member keeps its value; `allowedApplications: []` means all.
@http(method: "PATCH", uri: "/meters/{meterId}", code: 200)
operation UpdateMeter {
    input := {
        @required
        @httpLabel
        meterId: MeterId

        unit: MeterUnit

        rule: SumRule

        allowedApplications: ApplicationIdList
    }
    output := {
        @required
        meter: MeterVersion
    }
    errors: [
        ResourceNotFoundException
        ConflictException
    ]
}

/// Retires the meter from the next whole hour; versions are kept.
@idempotent
@http(method: "DELETE", uri: "/meters/{meterId}", code: 200)
operation DeleteMeter {
    input := {
        @required
        @httpLabel
        meterId: MeterId
    }
    output := {
        @required
        meter: MeterVersion
    }
    errors: [
        ResourceNotFoundException
    ]
}

@readonly
@paginated(inputToken: "nextToken", outputToken: "nextToken", pageSize: "maxResults", items: "meters")
@http(method: "GET", uri: "/meters")
operation ListMeters {
    input := {
        @httpQuery("nextToken")
        nextToken: PaginationToken

        @httpQuery("maxResults")
        maxResults: PageSize
    }
    output := {
        @required
        meters: MeterVersionList

        nextToken: PaginationToken
    }
}

// ---------------------------------------------------------------------------
// Sinks (spec §4.4)
// ---------------------------------------------------------------------------

resource Sink {
    identifiers: {
        sinkId: SinkId
    }
    read: GetSink
    update: UpdateSink
    delete: DeleteSink
    list: ListSinks
    operations: [
        CreateSink
    ]
}

/// Where a target field takes its value from.
union MappingSource {
    /// A usage record field (spec §4.7).
    recordField: FieldName

    /// A meter field (spec §4.1).
    meterField: FieldName

    constant: MappingConstant
}

@pattern("^[A-Za-z][A-Za-z0-9_]{0,63}$")
string FieldName

@length(min: 0, max: 256)
string MappingConstant

@length(max: 50)
map FieldMapping {
    key: FieldName
    value: MappingSource
}

/// An HTTPS endpoint, or for `S3_EXPORT` a key prefix in the export bucket.
@length(min: 1, max: 2048)
string SinkEndpoint

/// A Secrets Manager name under `<fleet>/metering/sinks/` (spec §4.4).
@pattern("^[A-Za-z0-9/_+=.@-]{1,512}$")
string SecretName

@length(max: 100)
list MeterIdList {
    member: MeterId
}

structure SinkSummary {
    @required
    sinkId: SinkId

    @required
    type: SinkType

    @required
    enabled: Boolean

    @required
    endpoint: SinkEndpoint

    secretName: SecretName

    mapping: FieldMapping

    meters: MeterIdList

    @required
    createdBy: String

    @required
    createdAt: IsoTimestamp
}

list SinkSummaryList {
    member: SinkSummary
}

/// Not idempotent: a repeat is a 409 `ALREADY_EXISTS`. `CreateSink` and
/// `UpdateSink` refuse a `secretName` outside `<fleet>/metering/sinks/`
/// with a `ValidationError` (spec §4.4).
@http(method: "POST", uri: "/sinks", code: 201)
operation CreateSink {
    input := {
        @required
        sinkId: SinkId

        @required
        type: SinkType

        @required
        enabled: Boolean

        @required
        endpoint: SinkEndpoint

        secretName: SecretName

        mapping: FieldMapping

        meters: MeterIdList
    }
    output := {
        @required
        sink: SinkSummary
    }
    errors: [
        ConflictException
    ]
}

@readonly
@http(method: "GET", uri: "/sinks/{sinkId}")
operation GetSink {
    input := {
        @required
        @httpLabel
        sinkId: SinkId
    }
    output := {
        @required
        sink: SinkSummary
    }
    errors: [
        ResourceNotFoundException
    ]
}

/// An absent member keeps its value; `meters: []` means all, and
/// `mapping: {}` clears the mapping.
@http(method: "PATCH", uri: "/sinks/{sinkId}", code: 200)
operation UpdateSink {
    input := {
        @required
        @httpLabel
        sinkId: SinkId

        enabled: Boolean

        endpoint: SinkEndpoint

        secretName: SecretName

        mapping: FieldMapping

        meters: MeterIdList
    }
    output := {
        @required
        sink: SinkSummary
    }
    errors: [
        ResourceNotFoundException
    ]
}

@idempotent
@http(method: "DELETE", uri: "/sinks/{sinkId}", code: 204)
operation DeleteSink {
    input := {
        @required
        @httpLabel
        sinkId: SinkId
    }
    output := {}
    errors: [
        ResourceNotFoundException
    ]
}

@readonly
@paginated(inputToken: "nextToken", outputToken: "nextToken", pageSize: "maxResults", items: "sinks")
@http(method: "GET", uri: "/sinks")
operation ListSinks {
    input := {
        @httpQuery("nextToken")
        nextToken: PaginationToken

        @httpQuery("maxResults")
        maxResults: PageSize
    }
    output := {
        @required
        sinks: SinkSummaryList

        nextToken: PaginationToken
    }
}

// ---------------------------------------------------------------------------
// Registrations (spec §3.4, §4.2, §4.3). Idempotent: hooks run again.
// ---------------------------------------------------------------------------

/// The control plane's ids for the operation that made a registration.
@mixin
structure ControlPlaneTrace {
    @length(min: 1, max: 128)
    controlPlaneExecutionId: String

    @length(min: 1, max: 256)
    controlPlaneOperatorId: String
}

/// The same ids, sent as headers on the `DELETE` registrations.
@mixin
structure ControlPlaneTraceHeaders {
    @httpHeader("X-Control-Plane-Execution-Id")
    @length(min: 1, max: 128)
    controlPlaneExecutionId: String

    @httpHeader("X-Control-Plane-Operator-Id")
    @length(min: 1, max: 256)
    controlPlaneOperatorId: String
}

structure Interval {
    @required
    activeFrom: IsoTimestamp

    @required
    closedAt: IsoTimestamp
}

list IntervalList {
    member: Interval
}

resource CellEmitter {
    identifiers: {
        cellId: CellId
    }
    put: PutCellEmitter
    read: GetCellEmitter
    delete: DeleteCellEmitter
    list: ListCellEmitters
}

structure CellEmitterSummary with [ControlPlaneTrace] {
    @required
    cellId: CellId

    @required
    applicationId: ApplicationId

    @required
    accountId: AccountId

    @required
    roleName: String

    @required
    status: RegistrationStatus

    @required
    activeFrom: IsoTimestamp

    closedAt: IsoTimestamp

    closesAt: IsoTimestamp

    /// The control plane's ids for the delete that closed it.
    closedByExecutionId: String

    closedByOperatorId: String

    intervals: IntervalList

    @required
    createdBy: String

    @required
    createdAt: IsoTimestamp
}

list CellEmitterSummaryList {
    member: CellEmitterSummary
}

/// Registers a cell's emitter role `<fleet>-ue-<cellId>`. 409
/// `ACCOUNT_NOT_ALLOWED` in a subscriber account or the metering account
/// (ADR-0006); 409 `PLACEMENT_MISMATCH` for a known cell with another
/// account or application.
@idempotent
@http(method: "PUT", uri: "/cells/{cellId}/emitter", code: 200)
operation PutCellEmitter {
    input := with [ControlPlaneTrace] {
        @required
        @httpLabel
        cellId: CellId

        @required
        applicationId: ApplicationId

        @required
        accountId: AccountId
    }
    output := {
        @required
        emitter: CellEmitterSummary
    }
    errors: [
        ConflictException
    ]
}

@readonly
@http(method: "GET", uri: "/cells/{cellId}/emitter")
operation GetCellEmitter {
    input := {
        @required
        @httpLabel
        cellId: CellId
    }
    output := {
        @required
        emitter: CellEmitterSummary
    }
    errors: [
        ResourceNotFoundException
    ]
}

/// Moves the emitter to `CLOSING`; succeeds on a missing or closing item.
@idempotent
@http(method: "DELETE", uri: "/cells/{cellId}/emitter", code: 200)
operation DeleteCellEmitter {
    input := with [ControlPlaneTraceHeaders] {
        @required
        @httpLabel
        cellId: CellId
    }
    output := {
        emitter: CellEmitterSummary
    }
}

@readonly
@paginated(inputToken: "nextToken", outputToken: "nextToken", pageSize: "maxResults", items: "emitters")
@http(method: "GET", uri: "/emitters")
operation ListCellEmitters {
    input := {
        @httpQuery("nextToken")
        nextToken: PaginationToken

        @httpQuery("maxResults")
        maxResults: PageSize
    }
    output := {
        @required
        emitters: CellEmitterSummaryList

        nextToken: PaginationToken
    }
}

resource TenantBinding {
    identifiers: {
        cellId: CellId
        tenantId: TenantId
    }
    put: PutTenantBinding
    read: GetTenantBinding
    delete: DeleteTenantBinding
    list: ListTenantBindings
}

structure TenantBindingSummary with [ControlPlaneTrace] {
    @required
    cellId: CellId

    @required
    tenantId: TenantId

    @required
    applicationId: ApplicationId

    billingAccount: BillingAccount

    @required
    status: RegistrationStatus

    @required
    activeFrom: IsoTimestamp

    closedAt: IsoTimestamp

    closesAt: IsoTimestamp

    /// The control plane's ids for the delete that closed it.
    closedByExecutionId: String

    closedByOperatorId: String

    intervals: IntervalList

    @required
    createdBy: String

    @required
    createdAt: IsoTimestamp
}

list TenantBindingSummaryList {
    member: TenantBindingSummary
}

/// Binds a tenant to a cell. 409 `PLACEMENT_MISMATCH` when the cell has no
/// emitter or is of another application. An absent `billingAccount` keeps
/// the stored one. A newly set billing account starts a `RESEND_BLOCKED`
/// job for the tenant and application (spec §4.7), returned as
/// `resendJobId`.
@idempotent
@http(method: "PUT", uri: "/cells/{cellId}/tenants/{tenantId}", code: 200)
operation PutTenantBinding {
    input := with [ControlPlaneTrace] {
        @required
        @httpLabel
        cellId: CellId

        @required
        @httpLabel
        tenantId: TenantId

        @required
        applicationId: ApplicationId

        billingAccount: BillingAccount
    }
    output := {
        @required
        binding: TenantBindingSummary

        resendJobId: JobId
    }
}

@readonly
@http(method: "GET", uri: "/cells/{cellId}/tenants/{tenantId}")
operation GetTenantBinding {
    input := {
        @required
        @httpLabel
        cellId: CellId

        @required
        @httpLabel
        tenantId: TenantId
    }
    output := {
        @required
        binding: TenantBindingSummary
    }
    errors: [
        ResourceNotFoundException
    ]
}

/// Moves the binding to `CLOSING`; succeeds on a missing or closing item.
@idempotent
@http(method: "DELETE", uri: "/cells/{cellId}/tenants/{tenantId}", code: 200)
operation DeleteTenantBinding {
    input := with [ControlPlaneTraceHeaders] {
        @required
        @httpLabel
        cellId: CellId

        @required
        @httpLabel
        tenantId: TenantId
    }
    output := {
        binding: TenantBindingSummary
    }
}

@readonly
@paginated(inputToken: "nextToken", outputToken: "nextToken", pageSize: "maxResults", items: "bindings")
@http(method: "GET", uri: "/cells/{cellId}/tenants")
operation ListTenantBindings {
    input := {
        @required
        @httpLabel
        cellId: CellId

        @httpQuery("nextToken")
        nextToken: PaginationToken

        @httpQuery("maxResults")
        maxResults: PageSize
    }
    output := {
        @required
        bindings: TenantBindingSummaryList

        nextToken: PaginationToken
    }
}

// ---------------------------------------------------------------------------
// Usage records (spec §4.7)
// ---------------------------------------------------------------------------

structure UsageRecord {
    @required
    recordId: String

    @required
    kind: RecordKind

    @required
    tenantId: TenantId

    @required
    applicationId: ApplicationId

    @required
    meterId: MeterId

    @required
    meterVersion: Integer

    @required
    hour: Hour

    @required
    seq: Integer

    @required
    revision: Integer

    @required
    quantity: Quantity

    @required
    total: Quantity

    /// Below 2^53 (JavaScript safe integers).
    @required
    eventCount: Long

    billingAccount: BillingAccount

    sinks: SinkDeliveries
}

structure SinkDelivery {
    @required
    status: DeliveryStatus

    reason: String
}

map SinkDeliveries {
    key: SinkId
    value: SinkDelivery
}

list UsageRecordList {
    member: UsageRecord
}

@readonly
@paginated(inputToken: "nextToken", outputToken: "nextToken", pageSize: "maxResults", items: "records")
@http(method: "GET", uri: "/tenants/{tenantId}/applications/{applicationId}/meters/{meterId}/usage")
operation GetUsage {
    input := {
        @required
        @httpLabel
        tenantId: TenantId

        @required
        @httpLabel
        applicationId: ApplicationId

        @required
        @httpLabel
        meterId: MeterId

        @required
        @httpQuery("from")
        from: Hour

        @required
        @httpQuery("to")
        to: Hour

        @httpQuery("nextToken")
        nextToken: PaginationToken

        @httpQuery("maxResults")
        maxResults: PageSize
    }
    output := {
        @required
        records: UsageRecordList

        nextToken: PaginationToken
    }
}

@readonly
@paginated(inputToken: "nextToken", outputToken: "nextToken", pageSize: "maxResults", items: "records")
@http(method: "GET", uri: "/tenants/{tenantId}/applications/{applicationId}/usage")
operation ListUsage {
    input := {
        @required
        @httpLabel
        tenantId: TenantId

        @required
        @httpLabel
        applicationId: ApplicationId

        @required
        @httpQuery("from")
        from: Hour

        @required
        @httpQuery("to")
        to: Hour

        @httpQuery("nextToken")
        nextToken: PaginationToken

        @httpQuery("maxResults")
        maxResults: PageSize
    }
    output := {
        @required
        records: UsageRecordList

        nextToken: PaginationToken
    }
}

// ---------------------------------------------------------------------------
// Hours (spec §4.5)
// ---------------------------------------------------------------------------

resource MeteringHour {
    identifiers: {
        hour: Hour
    }
    read: GetHour
    list: ListHours
}

structure HourSummary {
    @required
    hour: Hour

    @required
    status: HourStatus

    /// Below 2^53 (JavaScript safe integers).
    @required
    generation: Long

    countedGeneration: Long

    countedAt: IsoTimestamp

    @required
    attempts: Integer
}

list HourSummaryList {
    member: HourSummary
}

@readonly
@http(method: "GET", uri: "/hours/{hour}")
operation GetHour {
    input := {
        @required
        @httpLabel
        hour: Hour
    }
    output := {
        @required
        hourSummary: HourSummary
    }
    errors: [
        ResourceNotFoundException
    ]
}

/// The hours that are not `CLOSED`.
@readonly
@paginated(inputToken: "nextToken", outputToken: "nextToken", pageSize: "maxResults", items: "hours")
@http(method: "GET", uri: "/hours")
operation ListHours {
    input := {
        @httpQuery("nextToken")
        nextToken: PaginationToken

        @httpQuery("maxResults")
        maxResults: PageSize
    }
    output := {
        @required
        hours: HourSummaryList

        nextToken: PaginationToken
    }
}

// ---------------------------------------------------------------------------
// Jobs (spec §4.6)
// ---------------------------------------------------------------------------

resource Job {
    identifiers: {
        jobId: JobId
    }
    read: GetJob
    list: ListJobs
}

/// Counts stay below 2^53 (JavaScript safe integers).
structure JobCounts {
    @required
    processed: Long

    @required
    admitted: Long

    @required
    refused: Long

    @required
    redriven: Long
}

structure JobSummary {
    @required
    jobId: JobId

    @required
    kind: JobKind

    @required
    status: JobStatus

    @required
    counts: JobCounts

    /// The job's inputs (spec §4.6).
    from: Hour

    to: Hour

    reason: ReadmittableReason

    sinkId: SinkId

    tenantId: TenantId

    applicationId: ApplicationId

    /// Why the job `FAILED`.
    statusReason: String

    @required
    createdBy: String

    @required
    createdAt: IsoTimestamp

    @required
    updatedAt: IsoTimestamp
}

list JobSummaryList {
    member: JobSummary
}

/// Both bounds inclusive; at most 744 hours (31 days) apart.
@mixin
structure HourRange {
    @required
    from: Hour

    @required
    to: Hour
}

/// Recounts each hour in range; 409 when the whole range is `CLOSED` or
/// within 5 minutes of its close.
@http(method: "POST", uri: "/jobs/recount", code: 202)
operation StartRecount {
    input := with [HourRange] {}
    output := {
        @required
        job: JobSummary
    }
    errors: [
        ConflictException
    ]
}

@http(method: "POST", uri: "/jobs/readmission", code: 202)
operation StartReadmission {
    input := with [HourRange] {
        reason: ReadmittableReason
    }
    output := {
        @required
        job: JobSummary
    }
}

@http(method: "POST", uri: "/jobs/ingest-redrive", code: 202)
operation StartIngestRedrive {
    input := {}
    output := {
        @required
        job: JobSummary
    }
}

/// Sends a sink's `FAILED` deliveries again, or with an hour range every
/// record of the range (a backfill).
@http(method: "POST", uri: "/jobs/sink-redrive", code: 202)
operation StartSinkRedrive {
    input := {
        @required
        sinkId: SinkId

        from: Hour

        to: Hour
    }
    output := {
        @required
        job: JobSummary
    }
    errors: [
        ResourceNotFoundException
    ]
}

@http(method: "POST", uri: "/jobs/resend-blocked", code: 202)
operation StartResendBlocked {
    input := {
        @required
        tenantId: TenantId

        @required
        applicationId: ApplicationId
    }
    output := {
        @required
        job: JobSummary
    }
}

@readonly
@http(method: "GET", uri: "/jobs/{jobId}")
operation GetJob {
    input := {
        @required
        @httpLabel
        jobId: JobId
    }
    output := {
        @required
        job: JobSummary
    }
    errors: [
        ResourceNotFoundException
    ]
}

@readonly
@paginated(inputToken: "nextToken", outputToken: "nextToken", pageSize: "maxResults", items: "jobs")
@http(method: "GET", uri: "/jobs")
operation ListJobs {
    input := {
        @httpQuery("nextToken")
        nextToken: PaginationToken

        @httpQuery("maxResults")
        maxResults: PageSize
    }
    output := {
        @required
        jobs: JobSummaryList

        nextToken: PaginationToken
    }
}
