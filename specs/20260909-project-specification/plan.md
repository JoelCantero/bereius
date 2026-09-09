# Implementation Plan: Berea Booking Manager — Phase 1

**Branch**: `20260909-project-specification` | **Date**: 2026-09-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/20260909-project-specification/spec.md`

**Note**: This plan covers Phase 1 of the delivery phases recorded in the specification. Phases 2 to
4 — bank reconciliation, calendar synchronisation and closing the cycle — get their own feature
directories once Phase 1 is merged.

## Summary

Replace the n8n booking workflow with an application-owned pipeline. Booking requests are read
hourly from the Gravity Forms REST API, persisted with an explicit lifecycle, reviewed and decided
on screen by an authenticated operator, and — on approval — turned into a Holded contact, estimate
and reserve invoice. Every transition is attributed and auditable. Payment is recorded by hand in
this phase; automatic reconciliation arrives in Phase 2.

Technical approach: a `booking` domain module under `src/modules/booking` owns the state machine and
the persistence, and never talks to an external system directly. All outbound work — Holded calls
and booking email — is queued in a database-backed outbox and drained by a `worker` container that
also runs the hourly intake and the daily expiry. That split exists because approving a booking must
succeed even when Holded is unreachable: the decision is a local write, and the four dependent
Holded calls are retryable work that must not run inside the operator's request.

Two integration clients are added under `src/lib`, both following the `executeProviderRequest`
pattern already used by the email providers, so timeouts, response size limits and status
classification are inherited rather than reimplemented.

## Technical Context

**Language/Version**: TypeScript 6.0.x on Node.js 24 LTS

**Package Manager**: pnpm

**Primary Dependencies**: Next.js 16 (App Router) + React 19, Tailwind CSS 4, Prisma 7, Zod 4,
Auth.js (NextAuth 4, patched), next-intl, Pino. One new runtime dependency: `nodemailer` for the SMTP
booking channel — see Complexity Tracking.

**Storage**: PostgreSQL via Prisma. Seven new tables and one new column on `User`. No existing table
is altered beyond that column.

**Money**: integer minor units (cents) stored as `Int`. Rounding is explicit at the boundary where an
amount is sent to Holded. Floating point never touches an amount, which is the defect that made the
retired workflow emit values like `1963.6363636363637`.

**Dates**: stay dates are `@db.Date`, not timestamps. Night counts are calendar differences, never
millisecond subtraction, so a stay spanning a daylight saving change cannot produce fractional
billable units.

**Testing**: Vitest for unit coverage of pricing, date arithmetic and the state machine; Vitest
integration against a real PostgreSQL database for lifecycle transitions, intake idempotency and
outbox behaviour; Playwright for the review-to-approval path with the Holded boundary stubbed at
HTTP. Money and date arithmetic get table-driven unit tests including a daylight-saving stay and a
group below the 30-place floor, because both are known defects of the system being replaced.

**Target Platform**: Docker (Linux containers) on Raspberry Pi (ARM64), portable to VPS; ingress via
Cloudflare Tunnel -> Traefik

**Project Type**: Web application — Next.js full-stack `app` container, plus a new `worker` container
sharing the same image and Prisma client

**Deployment**: Docker Compose. Adds one service, `worker`, on the `internal` network only, with no
ingress and `restart: unless-stopped`. It shares the application image and entrypoint script, so
there is no second build.

**CI/CD**: GitHub Actions. No pipeline change beyond the existing gates covering the new code.

**Secrets**: Three new environment secrets — Holded API key, Gravity Forms API credentials, and
`BOOKING_MAIL_KEY`, the AES-256-GCM key that encrypts the stored SMTP password. All read through
`src/lib/env.ts`. The SMTP password itself is deliberately not an environment variable: it is
configured through the interface, and stored encrypted, so an operator can change the mailbox without
a redeploy.

**Observability**: Existing Pino logger. New structured events for intake batches (entries read,
created, skipped), state transitions, outbox attempts with outcome class, and Holded call outcomes.
Tax identifiers, addresses, phone numbers and the SMTP password are redacted; amounts and booking
identifiers are not.

**Migration Strategy**: Forward-only and purely additive. One migration creates the booking tables
and enums, and adds `User.role UserRole @default(OPERATOR)`. Nothing existing is rewritten, so
deploying the migration ahead of the application code is safe and the compatibility window is
unbounded: existing behaviour cannot observe the new tables. The corrective forward migration drops
the new tables and the column; authentication, accounts and email do not reference them.

**Recovery Strategy**: The documented `scripts/db-backup.sh` and `scripts/db-restore.sh` procedure is
unchanged, because the migration adds tables rather than transforming data. If the pipeline
misbehaves in production, stopping the `worker` container halts every external effect — intake,
Holded calls, outbound mail — while leaving the application readable and the outbox intact; queued
work resumes when the worker restarts. The n8n workflow remains available as a fallback until this
phase is verified in production, and is only switched off once it is.

**Performance Goals**: Approval is a single database transaction plus outbox writes, so it returns
without waiting on Holded; p95 under 200 ms on Raspberry Pi. Intake is one paginated API read per
hour. The review queue is indexed on state and creation date.

**Constraints**: Raspberry Pi memory and CPU limits; no host-specific paths; portable to VPS. The
worker must be idempotent and safe to restart mid-batch. No booking may reach a terminal state
without an audit record. Personal data must never appear in logs or in the calendar feed.

**Scale/Scope**: Single-instance self-hosted deployment; tens of booking requests per month. Scope
for this phase: 1 migration, 7 tables, 1 domain module, 2 integration clients, 1 worker service,
3 screens, 3 message catalogues.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Status |
|-----------|------|--------|
| I. Docker-First, Portable by Default | One new service built from the existing image; no host path, no host-specific configuration | PASS |
| II. Separate by Operational Responsibility | Scheduled and retryable work moves to a `worker`, which is exactly the separation this principle calls for; the split is operational, not an artificial layer | PASS |
| III. Reverse Proxy and Network Isolation | The worker joins `internal` only and publishes no port; no new ingress surface | PASS |
| IV. VPS Migration as Design Constraint | New service and secrets are declarative; the migration checklist gains three environment variables and one service | PASS |
| V. Secrets Never Committed | Three new environment secrets, none committed; the SMTP password is encrypted at rest with an environment-held key | PASS |
| VI. Data Persistence, Backups, Restore | Additive migration only; backup and restore procedure unchanged; corrective forward migration defined | PASS |
| VII. Minimal, Boring, Maintainable Stack | One new dependency (`nodemailer`), justified below; integration clients reuse the existing provider HTTP pattern rather than adding SDKs | PASS |
| VIII. Health, Logs, Resource Awareness | Structured events for intake, transitions and outbox outcomes; the worker logs failures and shuts down gracefully | PASS |
| IX. CI/CD Reproducible | Existing lint, typecheck, test, build and E2E gates cover the new code; no pipeline change | PASS |
| X. Security by Default | Zod validation at every boundary; role checks on every operator action; no client-supplied identity trusted; secrets never logged; encrypted credential storage; the public form is untrusted input | PASS |
| XI. Specs Before Implementation | spec.md is complete with no open decisions; this plan precedes implementation; Non-Goals recorded | PASS |
| XII. Tests and Verification Required | Money and lifecycle correctness are critical: integration tests against a real database are mandatory and planned, not unit-only | PASS |
| XIII. Public Discoverability and Indexing | Booking screens are authenticated and non-indexable; no public page is added in this phase | PASS |

**Result**: All gates pass. One dependency is recorded in Complexity Tracking.

### Deliberate deferral

The specification keeps an explicit organisation boundary so a second house could be added later.
This plan does **not** create an `Organisation` table. A single-row table joined from every query
buys nothing today and complicates every read. The boundary stays a documented concept; introducing
it is a mechanical change if a second house ever appears.

## Project Structure

### Documentation (this feature)

```text
specs/20260909-project-specification/
|-- spec.md
|-- plan.md              # This file
|-- data-model.md        # Prisma models, enums, indexes and constraints
|-- research.md          # Holded document API and Gravity Forms REST v2 findings
|-- quickstart.md        # Local setup: credentials, seeding, running the worker
`-- tasks.md             # Ordered, dependency-aware task list
```

### Source Code (repository root)

```text
src/
|-- modules/
|   `-- booking/
|       |-- actions/           # Server Actions for approve, reject, record payment, settings
|       |-- components/        # Review queue, request detail, settings form
|       |-- services/
|       |   |-- intake.ts      # Gravity Forms entries -> BookingRequest, idempotent
|       |   |-- lifecycle.ts   # State machine and audit writes
|       |   |-- pricing.ts     # Bands, 30-place floor, advance and deposit
|       |   |-- quoting.ts     # Holded contact, estimate, reserve invoice sequence
|       |   |-- payments.ts    # Manual payment recording
|       |   |-- outbox.ts      # Enqueue and drain integration jobs
|       |   `-- mail-settings.ts
|       `-- schema.ts          # Zod schemas for form entries and operator input
|-- lib/
|   |-- holded/                # Contacts and documents client
|   |-- gravity-forms/         # Entries client with cursor paging
|   `-- mail/smtp.ts           # Booking channel transport
|-- app/
|   `-- [locale]/
|       `-- bookings/          # Queue, detail and settings screens
|-- messages/                  # ca, es, en copy for the new screens and emails
`-- worker/
    `-- index.ts               # Scheduler: hourly intake, outbox drain, daily expiry

prisma/
|-- schema.prisma
`-- migrations/<timestamp>_add_booking_pipeline/

tests/
|-- unit/                      # pricing, date arithmetic, state machine
|-- integration/               # lifecycle, intake idempotency, outbox
`-- e2e/                       # review to approval with Holded stubbed
```

**Structure Decision**: The booking domain lives in `src/modules/booking` following the existing
module convention. The dependency direction is preserved: screens and Server Actions call domain
services, services call `src/lib/db.ts` and the integration clients, and nothing calls in the
opposite direction. The worker imports the same domain services rather than duplicating logic, which
is why it ships in the same image.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| New dependency `nodemailer` | The booking channel must send through an arbitrary SMTP server configured by an administrator | Implementing SMTP, its TLS negotiation and its authentication mechanisms by hand is far more risk than one well-established dependency; sending booking mail through the existing HTTPS provider was rejected because it cannot send as `hola@berea.cat` without changing the DNS of the live domain |
| New `worker` service | Intake, outbox drain and expiry are scheduled, retryable and must not run inside a request | Running schedules inside the `app` container via timers breaks on restart, duplicates work if the app is ever scaled, and couples an operator's approval latency to Holded's availability |
