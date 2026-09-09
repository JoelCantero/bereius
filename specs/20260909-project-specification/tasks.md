---

description: "Task list for Berea Booking Manager — Phase 1"
---

# Tasks: Berea Booking Manager — Phase 1

**Input**: Design documents from `/specs/20260909-project-specification/`

**Prerequisites**: plan.md (required), spec.md (required), data-model.md, research.md

**Tests**: Required. Money and lifecycle correctness are critical (constitution Principle XII), and the system being replaced is known to have mis-billed groups below 30 places and to have produced fractional night counts. Integration tests run against a real PostgreSQL database.

**Organization**: Tasks are grouped by capability so each group can be implemented and verified independently once the foundational phase is complete.

## Format: `[ID] [P?] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- Include exact file paths in descriptions

## Path Conventions

- **Application**: `src/app/[locale]/bookings/` for screens; `src/modules/booking/` for domain behaviour
- **Integration clients**: `src/lib/holded/`, `src/lib/gravity-forms/`, `src/lib/mail/`
- **Worker**: `src/worker/`
- **Tests**: `tests/unit/`, `tests/integration/`, `tests/e2e/`
- Message catalogs move together: any key added to `src/messages/en.json` must be added to `es.json` and `ca.json` in the same task

---

## Phase 1: Setup

**Purpose**: Confirm a clean baseline and land the configuration surface the rest of the work depends on.

- [ ] T001 Verify the baseline is green before changing anything: run `pnpm install`, `docker compose up -d --wait db`, `pnpm db:deploy`, then `pnpm lint`, `pnpm typecheck` and `pnpm test`
- [ ] T002 Add `nodemailer` and its types as dependencies, and record the justification already stated in plan.md Complexity Tracking
- [ ] T003 Extend `src/lib/env.ts` with `HOLDED_API_KEY`, `GRAVITY_FORMS_API_URL`, `GRAVITY_FORMS_CONSUMER_KEY`, `GRAVITY_FORMS_CONSUMER_SECRET`, `GRAVITY_FORMS_FORM_ID` and `BOOKING_MAIL_KEY`, validated with Zod and failing fast at startup; mirror them in `.env.example` with comments and no real values

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The schema, the state machine and the audit trail. Everything else builds on these.

**CRITICAL**: No capability work can begin until this phase is complete.

- [ ] T004 Add the booking models and enums to `prisma/schema.prisma` per data-model.md: `Customer`, `BookingRequest`, `HoldedDocument`, `Payment`, `BookingAuditEvent`, `IntegrationJob`, `BookingMailSettings`, plus `BookingState`, `BoardType`, `DocumentType`, `IntegrationJobStatus` and `UserRole`; add `role UserRole @default(OPERATOR)` to `User` without touching its other fields
- [ ] T005 Add indexes for the read paths that exist: `BookingRequest` on `(state, createdAt)` and on `gravityEntryId` (unique), `IntegrationJob` on `(status, runAfter)`, `Customer` on `taxId` (unique)
- [ ] T006 Create the forward-only migration with `pnpm db:migrate --name add_booking_pipeline` and confirm the generated SQL only creates tables, types and one nullable-safe column with a default — no rewrite, no backfill
- [ ] T007 Implement the state machine in `src/modules/booking/services/lifecycle.ts`: allowed transitions only, reason required for reject and cancel, and every transition writing a `BookingAuditEvent` inside the same transaction as the state change
- [ ] T008 Write integration tests in `tests/integration/booking-lifecycle.test.ts` proving every legal transition, that illegal transitions are refused, that an audit row exists for each one, and that a failed transition leaves no partial write

---

## Phase 3: Pricing

**Purpose**: The billing rules recovered from the retired workflow, with its two defects fixed.

- [ ] T009 Implement `src/modules/booking/services/pricing.ts`: calendar night count, the 30-place billable floor, headcount band selection (up to 39, 40-59, 60-79, 80+), board-type SKU resolution, the 30% advance and the fixed 200 EUR deposit, all in integer cents
- [ ] T010 Write table-driven unit tests in `tests/unit/booking-pricing.test.ts` covering: a stay spanning a daylight saving change yields an integer night count; a group of 22 bills 30 places; each band boundary (39/40, 59/60, 79/80); and that no computed amount is a floating point value

---

## Phase 4: Intake

**Purpose**: Read submissions from Gravity Forms hourly, idempotently.

- [ ] T011 Implement the Gravity Forms client in `src/lib/gravity-forms/client.ts` using the `executeProviderRequest` pattern from `src/lib/email/`, with ascending entry-id paging, an explicit timeout and a response size limit
- [ ] T012 Define the entry schema in `src/modules/booking/schema.ts` with Zod, mapping **by field identifier** and documenting the identifier-to-meaning correspondence in a comment; reject entries that do not match rather than importing partial data
- [ ] T013 Implement `src/modules/booking/services/intake.ts`: read entries after the stored cursor, create `BookingRequest` and `Customer` rows, and advance the cursor only after the batch is committed
- [ ] T014 Write integration tests in `tests/integration/booking-intake.test.ts` proving that reprocessing the same entry creates nothing new, that the cursor does not advance when the transaction fails, and that a malformed entry is recorded as rejected without blocking the rest of the batch

---

## Phase 5: Outbox and worker

**Purpose**: Make external effects retryable and keep them out of the operator's request.

- [ ] T015 Implement `src/modules/booking/services/outbox.ts`: enqueue a job with a payload and an idempotency key derived from the booking, claim jobs atomically so two runs cannot process the same row, apply bounded attempts with exponential backoff, and move exhausted jobs to a dead state that is visible rather than silent
- [ ] T016 Implement the scheduler in `src/worker/index.ts`: hourly intake, outbox drain, daily expiry of requests past the three-day deadline; log every run with counts and outcomes; shut down gracefully on `SIGTERM` without abandoning a claimed job
- [ ] T017 Add the `worker` service to `docker-compose.prod.yml` on the `internal` network only, using the existing application image, with no published port and `restart: unless-stopped`
- [ ] T018 Write integration tests in `tests/integration/booking-outbox.test.ts` proving that a claimed job is not claimed twice, that a failing job is retried with backoff and eventually parked, and that a successful job is never executed a second time

---

## Phase 6: Holded integration

**Purpose**: Turn an approval into a contact, an estimate and a reserve invoice, idempotently.

- [ ] T019 Implement the Holded client in `src/lib/holded/client.ts`: contact lookup **by tax identifier using the API filter** (never by downloading the contact list), contact creation and update, estimate creation, estimate delivery, invoice creation from an estimate, and estimate line rewriting
- [ ] T020 Implement `src/modules/booking/services/quoting.ts` as a sequence of individually idempotent outbox jobs keyed by booking and step, so a retry after a partial failure resumes rather than duplicating; persist each returned Holded identifier as a `HoldedDocument` as soon as it is known
- [ ] T021 Write integration tests in `tests/integration/booking-quoting.test.ts` against a stubbed Holded boundary proving that a failure at the invoice step does not duplicate the estimate on retry, and that the booking never reports a document it did not receive an identifier for

---

## Phase 7: Booking mail channel

**Purpose**: A configurable SMTP sender, independent from the account mail provider.

- [ ] T022 Implement AES-256-GCM encryption helpers in `src/lib/mail/secret.ts` using Node `crypto` and `BOOKING_MAIL_KEY`, with the plaintext never returned once stored
- [ ] T023 Implement the SMTP transport in `src/lib/mail/smtp.ts` and a `sendTest` operation used by the settings screen, keeping the transport out of the request path by dispatching through the outbox
- [ ] T024 Build the settings screen and Server Action in `src/modules/booking/components/mail-settings-form.tsx` and `src/modules/booking/actions/mail-settings.ts`: administrator-only, password write-only, a send-test action that reports the failure reason without leaking the credential
- [ ] T025 Write unit tests in `tests/unit/booking-mail-settings.test.ts` proving the password is never present in a returned object, a log line or an error message, and that saving without changing the password preserves the stored one

---

## Phase 8: Review and decisions

**Purpose**: The screens where a person decides, with authorisation enforced server-side.

- [ ] T026 Add role checks to `src/server/` authorisation helpers so operator and administrator actions are enforced on the server, never inferred from the client
- [ ] T027 Build the review queue at `src/app/[locale]/bookings/page.tsx` with filtering by state and search by customer, tax identifier and date range
- [ ] T028 Build the request detail screen at `src/app/[locale]/bookings/[id]/page.tsx` showing the stay, the submitted customer data, the computed amounts, whether a Holded contact already exists, and the full audit trail
- [ ] T029 Implement the approve, reject and cancel Server Actions in `src/modules/booking/actions/decisions.ts`, each validating input with Zod, checking the role, writing the transition and enqueueing the resulting work in the same transaction
- [ ] T030 Implement manual payment recording in `src/modules/booking/actions/payments.ts` and `src/modules/booking/services/payments.ts`, moving a request to confirmed and recording who registered the transfer
- [ ] T031 Add the booking copy to `src/messages/en.json`, `es.json` and `ca.json` in a single change, covering the screens, the state names and the outbound emails
- [ ] T032 Implement the booking notifications — confirmation, rejection, cancellation, expiry, and the operator alert for a new pending request — sent through the booking SMTP channel
- [ ] T033 Write end-to-end coverage in `tests/e2e/booking-review.spec.ts` for the path from a pending request to an approved one with the estimate issued, against a stubbed Holded boundary

---

## Phase 9: Cut-over

**Purpose**: Retire n8n only once the replacement is proven.

- [ ] T034 Run both systems in parallel against production data for one review cycle, comparing the amounts the application computes with the amounts n8n produces, and record the comparison
- [ ] T035 Switch off the n8n workflows, revoke the credentials they used, and update `README.md` with the new operational picture: the worker service, the three new secrets and the booking settings screen
- [ ] T036 Run the full gate before opening the pull request: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e` and `pnpm audit:prod`

---

## Dependencies

- Phase 2 blocks everything.
- Phase 3 is independent of Phases 4 to 7 and can be done in parallel with them.
- Phase 6 depends on Phase 5, because every Holded call is dispatched through the outbox.
- Phase 8 depends on Phases 2, 3 and 6.
- Phase 9 depends on all of the above.

## Out of scope for this phase

Bank reconciliation (Phase 2 of delivery), the iCalendar feed (Phase 3), and the final invoice,
deposit refund and anonymisation job (Phase 4). Each gets its own feature directory.
