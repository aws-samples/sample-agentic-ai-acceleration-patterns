<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0005: Keep billing events off the telemetry path

- Status: Proposed
- Date: 2026-11-18
- Deciders: Dave Roberts (SA)

## Context
Many applications already run an OpenTelemetry collector, such as the AWS
Distro for OpenTelemetry (ADOT), and it is tempting to send usage through
it. The spike of 2026-11-17 found that ADOT has no exporter for
EventBridge, Firehose or S3; it reaches AWS through `otlphttp` with
SigV4, or through CloudWatch Logs. AWS multi-tenant architecture guidance
separates metering, which builds a bill, from metrics, which describe
the system.

## Options considered
### Option 1: Usage as OpenTelemetry logs through a shared collector
Pros: one agent per host; emitters reuse an SDK they have. Cons: the
collector batches, samples and drops by design; the path ends in a log
store (ADR-0002, option 4); the collector's identity, not the cell's,
signs the call unless each cell runs its own.

### Option 2: A small emitter client that calls `PutUsageEvents`
Pros: the cell's own role signs each call (ADR-0001); retries reuse the
`eventId`; no extra process. Cons: one more client in each runtime.

## Decision
Option 2 (P-1). The sample ships a TypeScript emitter snippet that
buffers, batches up to 500, signs with the default credential chain and
retries with the same `eventId`s.

## Consequences
- Usage and telemetry can still share dimensions; the emitter may also
  write a metric for dashboards, which is not billed from.
- A collector-based emitter is a seam: an OTLP receiver in front of the
  ingest door would need its own caller identity per cell.
