# Quickstart: Holded Bank Movements

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-09-16

Runnable validation for the feature. Data rules live in [data-model.md](./data-model.md); provider,
UI/action, and reconciliation behavior live in [contracts/](./contracts). All automated provider
responses MUST be synthetic and MUST NOT contain values copied from Holded production data.

## Prerequisites

- Node.js `>=24.15.0 <25.0.0` and pnpm `11.22.0` (pinned by `package.json`).
- Docker running for the development PostgreSQL container.
- A local `.env` derived from `.env.example` with the existing application/auth/database settings.
- For an optional live smoke test only, an administrator-configured existing Holded credential and
  a non-production treasury account that the credential may read. This feature adds no secret.
- A current logical database backup before applying the production migration.

## Local Setup

```bash
pnpm install
docker compose up -d --wait db
pnpm db:migrate
pnpm db:generate
NODE_ENV=development node prisma/seed.mjs
```

Validate the migration before feature tests:

```bash
pnpm exec prisma validate
pnpm db:generate
```

Expected result: five additive banking tables, five enums, and nullable unique
`Payment.bankMovementId` are available; existing payments and bookings remain valid without a
backfill.

## Focused Automated Verification

Run the narrow checks while implementing. The named banking tests are the expected Phase 2 test
surfaces and use synthetic provider data.

```bash
pnpm test -- \
  tests/unit/holded-treasury-client.test.ts \
  tests/unit/bank-movement-parser.test.ts

RUN_INTEGRATION_TESTS=true pnpm test -- \
  tests/integration/bank-sync.test.ts \
  tests/integration/bank-reconciliation.test.ts \
   tests/integration/bank-expiry.test.ts \
   tests/integration/bank-retention.test.ts

pnpm test -- \
  tests/unit/bank-movements-page.test.tsx \
   tests/unit/console-sidebar.test.tsx \
   tests/unit/seo.test.ts
```

Expected proof:

- **Provider boundary**: exact read-only path, Bearer header, `start_date`, `limit=100`, opaque
   cursors, complete exhaustion, unknown-field stripping, response-size bound, status-based sanitized
   failures with opaque bodies, and no treasury mutation method.
- **Parser**: exact two-decimal EUR-to-BigInt conversion, positive income, negative expense,
   rejected zero/non-EUR values, valid bank calendar dates, account identity, optional fields, and no
   text-based classification.
- **Synchronization with PostgreSQL**: page-atomic checkpoints, update-in-place, zero duplicates,
  one active run, concurrent claims, expired-lease recovery, bounded retry, partial/failed terminal
  states, and preservation of earlier rows.
- **Reconciliation with PostgreSQL**: only exact positive income/reference/currency/amount matches
  propose; confirmation atomically creates one linked payment, decision, booking transition, and
  audit event; dismissal/replay/correction cannot duplicate or auto-reverse it.
- **Expiry with PostgreSQL**: due bookings expire only after a fresh complete scan and remain
  awaiting payment on outage, partial scan, active retry, or pending proposal.
- **Retention with PostgreSQL**: the floor advances only after a committed terminal page records
   complete exhaustion; old unprotected movements and terminal run/incidents are pruned in bounded
   batches, protected records remain, and the next scan cannot re-import pruned rows.
- **UI/component**: role-filtered navigation, URL filters, full-filter currency totals, stable
   ordering/paging, all run states, keyboard operation, announcements, textual direction, explicit
   `noindex`, sitemap exclusion, and compatible robots behavior.

## Run the Application

```bash
pnpm dev
```

Open `http://localhost:3000`. English is unprefixed; Spanish and Catalan use `/es` and `/ca`.

## Manual Validation Scenarios

Use synthetic seeded movements for display and reconciliation scenarios. A live Holded smoke test is
limited to confirming the already verified read contract and must not capture payloads or values.

1. **Least-privilege configuration** (US1). As an administrator, open the booking integrations
   page, select a non-archived EUR treasury account, leave the default start date at 90 days ago,
   and save. Confirm a non-EUR synthetic option cannot be selected and the credential is not
   requested again. As an operator, confirm account settings cannot be changed but the movements
   page and refresh action are available.
2. **Complete idempotent import** (US1, SC-002 to SC-004). Run a synthetic multi-page scan containing
   new, repeated, corrected, malformed, positive, and negative items. Run it again. Confirm one row
   per account/provider ID, corrected fields in place, exact counts, visible sanitized incidents,
   and a terminal cursor only after every page commits.
3. **Interrupted recovery** (US4, SC-008 to SC-009). Fail after one committed page, then reclaim an
   expired lease and retry. Existing rows stay visible, the run never reports success early, and the
   final result has no loss or duplicates. Repeat with a missing and repeated cursor. While the
   fixture keeps Holded unavailable, open the booking queue and complete one existing booking
   management action against an isolated synthetic booking; verify it succeeds and `/api/health`
   remains HTTP 200 while the authorized banking view reports integration degradation. Also verify
   degradation for a latest `RETRYING`/`PARTIAL`/`FAILED` run and for an inactive run whose latest
   success is absent or older than six hours, without mislabeling setup or an initial active run.
4. **Concurrent refresh** (US4, SC-005). Request a refresh in two sessions while a scheduled run is
   due. Both sessions identify one effective nonterminal run; progress updates without concurrent
   import or duplicate records. Repeated manual requests hit the database-backed cooldown. With the
   normal synthetic provider, confirm a newly returned movement is visible within two minutes of the
   accepted request.
5. **Filtering and totals** (US2, SC-006 to SC-007). With more than 50 synthetic rows across dates,
   retained accounts, directions, currencies, statuses, and narratives, combine every URL filter.
   Rows are newest first with a stable tie order; totals cover all matching pages and remain split by
   currency and income/expense magnitude. Start a timer from the loaded movement page, give the
   tester one named synthetic target and one of the supported filter strategies, and stop when the
   target row is identified; record a result below 60 seconds. Non-EUR rows in this query-only
   dataset exercise future-compatible grouping and are not provider-ingestion fixtures.
6. **Missing and invalid values** (US1 to US2). Confirm optional narrative/value date/status render a
   neutral localized value. Invalid identity/account/date/currency/amount and zero amounts render
   only sanitized incidents and never affect rows, totals, or proposals.
7. **Strict proposal rule** (US3, SC-010). Seed equal positive and negative movements containing the
   same estimate number. Only the positive exact-EUR movement proposes. Near references, partial or
   excessive amounts, multiple transfers, missing estimate numbers, and wrong currencies do not.
8. **Human confirmation** (US3). Confirm one pending proposal as an operator. Exactly one payment is
   linked, the booking moves from `AWAITING_PAYMENT` to `CONFIRMED`, and the existing audit/email path
   runs after commit. Re-submit and race a second session; neither creates another payment. Dismiss a
   separate proposal and confirm it stays dismissed after rescanning.
9. **Provider correction** (US1, US3). Correct a movement before confirmation so it no longer
   matches; the proposal becomes invalidated. Correct a confirmed movement; the human decision stays
   intact and a sanitized review incident appears, with no automatic reversal.
10. **Expiry freshness**. Seed an older successful run, then start expiry and prove that old success
   cannot authorize a transition. Simulate provider outage/partial response immediately before
   expiry; the due booking remains `AWAITING_PAYMENT`. Restore a complete scan whose first lease is
   after the captured expiry-attempt time, verify normal conditional expiry with no candidate, and
   verify a pending proposal still defers expiry.
11. **Localization, privacy, and accessibility** (US2, US4). Repeat page and action states at
    `/bank-movements`, `/es/bank-movements`, and `/ca/bank-movements`, including 320 px width and
   keyboard-only use. Verify `noindex`, explicit exclusion of all localized movement paths from the
   generated sitemap, robots rules that allow HTML pages to expose `noindex`, focus/announcements,
   visible direction text, and no credential, cursor, raw body, narrative, reference,
   counterparty, amount, or provider IDs in structured logs.
12. **Historical account scope** (US1). Switch the active account as an administrator. Historical
    movements remain filterable under their original account, the new account has an independent
    locked import start date, and only the new account receives scheduled runs.
13. **Retention floor** (US1, FR-047). Seed an old unmatched movement, old dismissed proposal, a
   payment-linked movement, a pending proposal, old terminal runs/incidents, and an incomplete
   partial latest run. Verify cleanup cannot advance or delete after that run. Commit a terminal
   page from the prior lower bound, rerun cleanup, and verify the floor advances monotonically,
   only unprotected rows and expired operational history disappear, and the next scan starts at
   the floor without re-importing the deleted movement. Repeat with complete pagination plus an
   item incident and verify its exhausted `PARTIAL` result may advance the floor.

## Full Quality Gate

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm audit:prod
pnpm build
pnpm test:e2e
```

`pnpm test:e2e` builds and serves the production standalone artifact against an isolated PostgreSQL
database. Its bank-movements scenario must cover signed-out redirect, operator/admin authorization,
the three locales, filters/totals, refresh states, manual proposal confirmation, outage isolation,
health separation, `noindex`, desktop, and the configured 320 px project. Extend the existing
`provider-fetch-preload.mjs` and loopback `provider-http-fixture.ts` so server-side requests to the
fixed Holded origin are forwarded with path/query intact to synthetic fixture behavior. Browser
request interception and live Holded calls do not satisfy this check; production code receives no
test-only base URL.

## Deployment and Recovery Check

1. Run the existing logical backup and verify its output before deployment:

   ```bash
   pnpm db:backup
   ```

2. Deploy migration-first through the existing one-shot migrator, then the compatible application
   image. No container, port, network, volume, environment variable, or credential is added.
3. Confirm the existing health endpoint remains HTTP 200 while process and PostgreSQL are healthy,
   including during a simulated Holded outage. Confirm the authorized banking view and structured
   operational signal report that outage as integration degradation instead of application
   unhealthiness.
4. Request one controlled non-production refresh and verify terminal status/counts plus redacted
   structured logs. Do not print or retain response data.
5. If application code fails, redeploy the prior image; it ignores the additive schema while bank
   records remain intact. Never rewrite or roll back an applied migration.
6. Fix schema defects with a new forward migration. Use the documented `pnpm db:restore` procedure
   only when recovery of the complete database is actually required and after stopping writes.