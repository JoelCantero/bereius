# Phase 0 Research: Holded Bank Movements

## Research Method and Privacy Boundary

The Holded contract was verified on 2026-09-16 against the real Berea company account with an
existing Holded personal access token. The token, treasury account identifier, account name, bank
numbers, movement identifiers, dates, amounts, balances, descriptions, references, and
counterparties were processed only in memory and were never printed, logged, committed, hashed, or
stored in these artifacts. Only field names, types, safe enums, aggregate counts, lexical formats,
and pagination behavior were retained.

The probe credential establishes the provider contract only. Production implementation MUST obtain
the credential through Bereius's existing encrypted `IntegrationSettings` row for `HOLDED`; it MUST
not add, copy, or persist another credential.

## Decision 1: Implement the Observed Holded v2 Contract Only

**Decision**: Extend the existing server-only Holded client with read methods for:

- `GET /api/v2/treasury/accounts`
- `GET /api/v2/treasury/accounts/{id}/bank-movements`

Use `limit=100`, `start_date=YYYY-MM-DD`, and the opaque `cursor` returned by the preceding page.
Repeat `start_date` and `limit` on cursor requests. Continue until `has_more` is `false`; a repeated
cursor, `has_more=true` without a cursor, malformed page, or failed page is partial failure, never
successful exhaustion.

**Verified evidence**:

- Both endpoints returned HTTP 200 JSON objects with the envelope keys `items`, `has_more`, and
  `cursor`.
- The default movement page contained 50 items. `limit=1` returned one item and `limit=100` returned
  100, proving that `limit` is honored.
- Supplying the returned cursor as `cursor=<opaque value>` produced the next 50-item page with zero
  overlapping movement IDs.
- A complete unfiltered walk reached `has_more=false` after 56 pages with zero duplicate movement
  IDs. No cursor value or item value was retained.
- A 90-day request using `start_date` and `limit=100` produced two pages of 100 and 25 items. The
  second request repeated `start_date` and `limit`, supplied the first response's `cursor`, reached
  the terminal page, and had zero overlap. Every returned booking date was on or after the requested
  start date.
- A future `start_date` returned zero items, proving that the filter is active. Equivalent probes
  named `since`, `from`, and `date_from`, and a `since`/`until` pair, returned the unchanged baseline
  page and are ignored. They MUST NOT be used.
- No `Link` or rate-limit pagination header was observed. The response did expose correlation and
  crawler headers, but their values are neither needed nor persisted.
- Provider item ordering was not retained or proven stable. No checkpoint, termination decision, or
  UI ordering relies on it; Bereius applies its own deterministic database order after import.
- No non-200 response body was captured. Authorization was not deliberately broken, rate limiting
  was not induced, and provider failures were not manufactured against the live account. Error
  bodies therefore remain opaque: only network outcomes, HTTP status, response bounds, and parsing
  of successful responses may drive the defensive error categories.

**Anonymized account envelope**:

```json
{
  "items": [
    {
      "id": "<treasury-account-id>",
      "name": "<account-display-name>",
      "currency": "EUR",
      "archived": false,
      "account_number": "<discarded>",
      "accounting_account_id": "<discarded>",
      "accounting_account_number": "<discarded>",
      "balance": "<discarded>",
      "bic": "<discarded>",
      "creditor_id": null,
      "iban": "<discarded>",
      "institution_id": "<discarded>",
      "institution_name": "<discarded>",
      "issuer_id": null,
      "synced_at": "<discarded>",
      "transactions_pending_to_reconcile": "<discarded>",
      "type": "<discarded>"
    }
  ],
  "has_more": false,
  "cursor": null
}
```

Only account `id`, `name`, `currency`, and `archived` are parsed for configuration. All other
account fields are discarded before crossing the provider adapter.

**Anonymized movement envelope**:

```json
{
  "items": [
    {
      "id": "<24-hex-movement-id>",
      "banking_account_id": "<configured-treasury-account-id>",
      "booking_date": "YYYY-MM-DDTHH:mm:ss+HH:mm",
      "value_date": "YYYY-MM-DDTHH:mm:ss+HH:mm",
      "description": "<bank-provided-narrative>",
      "amount": "-000.00",
      "currency": "EUR",
      "status": "pending",
      "accounting_amount": null,
      "accounting_currency": null,
      "balance": "<discarded>",
      "flagged_at": null,
      "note": "<empty>",
      "origin": "<discarded>",
      "reconciled_amount": "<discarded>"
    }
  ],
  "has_more": true,
  "cursor": "<opaque-cursor>"
}
```

Across the verified first 100-item page:

- `id` was always a non-empty 24-character hexadecimal string.
- `banking_account_id` always equaled the account in the request path.
- `booking_date` and `value_date` were non-null ISO datetimes with an explicit numeric offset,
  lexical shape `DDDD-DD-DDADD:DD:DD+DD:DD`.
- `amount` was always a signed decimal string with a dot separator and exactly two fractional
  digits. The first default page contained 10 positive and 40 negative amounts, with no zero or
  malformed amount.
- `currency` was non-null `EUR`.
- `status` was non-null and observed as `pending` or `reconciled`.
- `description` was non-empty; `note` was always empty.
- There was no distinct credit/debit indicator, reference, or counterparty field.

The adapter retains only `id`, `banking_account_id`, `booking_date`, `value_date`, `description`,
`amount`, `currency`, and `status`. It discards every accounting, balance, flag, note, and origin
field and every unknown extension. It does not expose the provider DTO outside the client.

**Rationale**: These are observed provider facts, not names inferred from another Holded endpoint or
from the internal Holded web application. They establish the successful-response and pagination
contract while explicitly bounding the unverified ordering and error-body surfaces.

**Alternatives considered**:

- Use Holded's internal browser endpoint: rejected because the feature mandates the public v2
  treasury endpoint and internal interfaces are not an integration contract.
- Use `since`/`until`: rejected because empirical probes showed they are ignored by the public
  endpoint.
- Copy the complete payload for later investigation: rejected because it would retain bank,
  accounting, and personal data the feature does not need.

## Decision 2: Add a Cohesive `banking` Domain Module

**Decision**: Place movement parsing, synchronization, account configuration, query projections,
manual-sync actions, reconciliation proposals, and UI components under `src/modules/banking`.
Keep generic provider transport in `src/lib/holded/client.ts`, authenticated pages under
`src/app/[locale]/(console)`, and persistence through `src/lib/db.ts`.

The booking domain remains responsible for booking state transitions and payment records. The
banking reconciliation service calls the booking transition boundary rather than moving booking
state independently.

**Rationale**: Banking has its own data lifecycle, synchronization state machine, permissions, and
UI. A dedicated module follows the repository's domain organization without introducing a second
application or service.

**Alternatives considered**:

- Put all behavior in `src/modules/booking`: rejected because provider synchronization and movement
  browsing are cohesive banking responsibilities used by, but not owned by, booking intake.
- Add a microservice or separate worker container: rejected for the observed scale and the
  constitution's minimal-stack rule.

## Decision 3: Store Account Configuration Separately but Reuse the Existing Credential

**Decision**: Add a minimal `HoldedTreasuryAccount` record containing the provider account ID,
display name, currency, first-import date, active flag, configuring administrator, synchronization
timestamps, and schedule time. Store no account number, IBAN, BIC, institution, balance, or complete
account response.

The existing administrator-only integrations page lists active Holded treasury accounts as
`name + currency`, using the existing encrypted Holded credential. Saving validates the selected
24-hex ID against the freshly read account list. Only one account is active; changing it deactivates
the previous row without deleting its movements. The first-import date defaults to the current UTC
date minus 90 calendar days and becomes immutable for an account once its first run is queued.

**Rationale**: A separate account row provides a stable relation for historical filters, display,
per-account scheduling, and safe synchronization state without duplicating an account label on
every movement or mixing operational state into encrypted integration settings.

**Alternatives considered**:

- Store account state only in the `HOLDED` JSON configuration: rejected because historical account
  relations, synchronization leases, and timestamps require relational constraints.
- Store account names on every movement: rejected as unnecessary duplication.
- Let administrators type opaque IDs: rejected because the existing settings UX selects verified
  Holded identifiers rather than inviting guesses.

## Decision 4: Use `BankSyncRun` as the Durable Queue, Lease, and Progress Record

**Decision**: Do not route bank synchronization through the current `IntegrationJob` outbox. A
`BankSyncRun` row represents queued, running, partial, successful, or failed work and contains only
technical progress counters, the request's fixed start date, the next opaque cursor, retry timing,
attempt count, lease token/expiry, trigger, requester ID, sanitized error code, and timestamps.

A banking scheduler starts from `instrumentation.ts`, checks every minute for due six-hour account
runs and queued/retryable work, and atomically leases a run. Multiple app instances compete through
conditional database updates and a database uniqueness constraint allowing at most one nonterminal
run per account. The worker renews the lease after every committed page. An expired lease is
reclaimed from the stored cursor. A manual action creates or returns the existing nonterminal run;
it never starts untracked work after the response ends.

Transient provider failures use bounded exponential retry. Authorization, invalid configuration,
malformed terminal contracts, or exhausted retries finish as failed when no page has committed and
as partial when the run already retained page progress. A run that reaches the terminal page with
item incidents also finishes partial. Manual retry resumes a partial/failed run from its safe cursor
or starts from page one if Holded rejects a stale cursor.

**Rationale**: The run already needs durable progress and status for the UI, so it can safely serve
as the queue without duplicating state. Unlike the current generic outbox, an expired bank lease is
explicitly recoverable after abrupt process termination.

**Alternatives considered**:

- Fire-and-forget from a Server Action: rejected because process termination can lose the work and
  no durable progress exists.
- Reuse `IntegrationJob` unchanged: rejected because a process crash can leave a claimed job parked
  indefinitely and its status does not model page checkpoints or user-visible partial results.
- Hold a database advisory lock while making provider calls: rejected because it would require a
  long-lived database session/transaction around external I/O.

## Decision 5: Commit One Complete Provider Page at a Time

**Decision**: A run begins at its immutable `start_date`; a fresh run starts without a cursor and a
resumed run uses its stored cursor. Each response page is validated in memory, then one short
database transaction:

1. verifies ownership of the unexpired run lease;
2. upserts every valid movement by account plus provider movement ID;
3. records sanitized incidents for invalid items;
4. creates, updates, or invalidates pending reconciliation proposals;
5. updates counters and the last processed technical position; and
6. stores the response's next cursor only after all page outcomes are durable.

If the transaction fails, none of the page or cursor commits. If the process stops after commit, the
next attempt begins at the stored next cursor. Re-reading a page is harmless because the database
unique key and upsert are idempotent. Cursor repetition is detected in memory without logging cursor
values.

The first run starts from the account's configured first-import date. Later six-hour or manual runs
start from the greater of that date and the account's monotonic retention floor. Holded exposes no
movement `updated_at`; rescanning the retained window is therefore the only verified way to observe
corrections or status changes. The floor advances only after clean exhaustion, so it cannot skip an
unprocessed page, and it prevents pruned unmatched movements from being re-imported. The observed
default 90-day window is two pages at `limit=100` (125 items), while the complete available history
was 56 default-size pages.

**Rationale**: Page transactions make the cursor an exact safe boundary and satisfy interruption,
idempotency, correction, and partial-failure requirements without one long database transaction.

**Alternatives considered**:

- Advance a success checkpoint from returned item dates: rejected because provider ordering is not
  established and equal-date entries or later corrections can be skipped. The separate retention
  floor advances only from policy time after a clean complete scan.
- Commit the cursor before item upserts: rejected because an interruption would permanently omit
  movements.
- Put the entire scan in one transaction: rejected because external pagination can hold locks and a
  database connection for too long.

## Decision 6: Normalize Money Exactly and Classify by Sign

**Decision**: Parse the observed decimal string directly into signed integer minor units without
first converting through JavaScript floating point. The initial adapter accepts only the evidenced
`EUR` value with exactly two fractional digits and persists it in a PostgreSQL/Prisma `BigInt`
minor-unit field. Reject zero, unparseable/out-of-range amounts, non-`EUR` currencies, account
mismatches, invalid IDs, and invalid dates as incidents. Keep the storage/query currency field
ISO-shaped so a later evidence-backed expansion does not require a schema redesign.

The observed endpoint has no credit/debit indicator. Positive amount is `INCOME`; negative amount is
`EXPENSE`. Descriptive text is never consulted. If Holded later adds a direction field, it is not
used until a new anonymized contract check confirms its exact name and values.

Dates are bank calendar dates, not event instants. Validate the full ISO-offset input, then retain
the `YYYY-MM-DD` calendar portion as a database date so display and filters cannot shift a movement
across days by server or browser timezone.

**Rationale**: This implements the only verified direction signal and avoids floating-point and
timezone drift.

**Alternatives considered**:

- Reuse the existing Number-based Holded document parser: rejected because bank totals and exact
  matching should not pass through floating point.
- Infer direction or counterparty from description words: rejected by the specification and because
  bank narratives are institution-specific.

## Decision 7: Treat `description` as the Single Narrative and Reference Source

**Decision**: Store the observed `description` once as the movement narrative. Present it as the
concept and use the same value as the reference source for the existing estimate-identifier
containment rule. Return `counterparty: null` because the mandated endpoint exposes no separate
counterparty. Do not parse names or duplicate the narrative into concept and reference columns.

The UI contract exposes nullable `concept`, `reference`, and `counterparty` projections so the
absence is explicit. For the current contract, concept and reference point to the same stored
narrative and counterparty renders a neutral localized empty value.

**Rationale**: This preserves the current matching rule with the only provider field that can carry
the transfer reference while honoring data minimization and avoiding unverified heuristics.

**Alternatives considered**:

- Split the narrative by bank-specific words: rejected because it invents a fragile provider
  contract and would extract personal names unnecessarily.
- Store the description twice: rejected because it adds no information.

## Decision 8: Persist Proposals and Confirm Them Transactionally

**Decision**: Add a `BankReconciliationProposal` relating a movement to an awaiting-payment booking.
Proposal generation requires all of the following:

- movement direction is `INCOME`;
- movement currency is the booking currency (`EUR` in the current booking model);
- the stored narrative contains the Holded estimate `documentNumber` literally; and
- positive movement minor units exactly equal `advanceCents + depositCents`.

Expenses, invalid movements, zero amounts, missing document numbers, partial/combined payments,
overpayments, and amount/reference near-matches create no proposal. A `(movement, booking)` unique
key prevents repeated scans from recreating a proposal. Dismissal records actor and time.

Confirmation uses one database transaction to re-evaluate the movement and booking, ensure the
proposal is still pending, create a `Payment` linked uniquely to the movement, mark the proposal
confirmed, invalidate sibling pending proposals, and call `transitionBooking(..., tx)` to reach
`CONFIRMED` with the existing audit event. The confirmation email is queued only after commit.
Already confirmed payments are never silently reversed if Holded later changes the movement; such a
change records a visible non-personal incident for operator resolution. Unconfirmed proposals that
no longer satisfy the rules are invalidated automatically.

Before expiring due bookings, the expiry flow requires a successful/acceptable final Holded scan.
If that scan is unavailable or incomplete, expiry is deferred rather than releasing dates while a
payment may be unread.

**Rationale**: This preserves strict reference-plus-amount matching and human confirmation while
making movement reuse, payment creation, booking transition, and audit atomic.

**Alternatives considered**:

- Create payments automatically: rejected because proposals require operator confirmation.
- Reuse expenses with an absolute amount: rejected because direction is a hard eligibility rule.
- Undo confirmed bookings after a provider correction: rejected because external corrections are
  not authority to reverse an operator decision automatically.

## Decision 9: Use a Server-Rendered Filtered View with a Small Polling Island

**Decision**: Add the localized authenticated route `/bank-movements`, protected by the existing
database-backed operator authorization and explicit `noindex` metadata. A Server Component parses
URL filters and loads a 50-row movement page, filter options, latest run state, incidents, proposals,
and totals grouped by direction plus currency. The database computes totals across the entire filter,
not the visible page.

Supported URL inputs are direction (`all|income|expense`), inclusive date range, account, currency,
case-insensitive text over the single narrative, and page. Default ordering is booking date
descending with provider movement ID as a deterministic tie-breaker.

A minimal Client Component owns the manual-refresh form, pending button, accessible status
announcements, and `router.refresh()` polling while the returned run is queued/running/retrying. It
does not receive credentials, cursors, raw provider errors, or broad database records. Account
selection remains an administrator-only form on the existing settings page.

**Rationale**: Server-side filtering keeps sensitive movement data behind authorization and avoids
an internal HTTP API. A small client island provides live progress without moving queries or secrets
to the browser.

**Alternatives considered**:

- Load every movement into a client table: rejected for privacy, payload size, totals correctness,
  and future scale.
- Add a custom polling API: rejected because Server Action plus route refresh meets the need with a
  smaller exposed surface.

## Decision 10: Use Existing Dependencies and Sanitized Observability

**Decision**: Add no package, service, public endpoint, secret, network, or volume. Reuse native
`fetch`, Zod, Prisma, PostgreSQL, next-intl, existing UI primitives, Pino, and the application
scheduler lifecycle.

Log only event name, run ID, local account row ID, trigger, state, attempt, durations, page/item and
insert/update/unchanged/incident counts, and sanitized error code. Never log provider account IDs,
cursors, movement IDs, narratives, references, counterparties, amounts, raw bodies, authorization
headers, or provider error bodies. User-visible incidents contain reason codes and technical page/
item positions only.

Apply a database-backed one-active-run rule and a short manual-trigger cooldown. Bound response
bytes, page work, text lengths, and retry attempts. A safety budget checkpoints and immediately
continues a large scan; reaching the budget is partial continuation, never silent success or
truncation.

**Rationale**: The installed stack already covers validation, persistence, authorization,
localization, jobs, and observability, and is suitable for the measured two-page default window on
the ARM64 target.

**Alternatives considered**:

- Add Redis or a broker: rejected because database-backed runs provide the required durability and
  concurrency at this scale.
- Log provider payloads for debugging: rejected because bank narratives contain third-party
  personal data.

## Decision 11: Apply a Monotonic 90-Day Unmatched-Movement Retention Floor

**Decision**: After an account has committed a terminal provider page and recorded complete
pagination, a daily banking cleanup advances that account's scan floor monotonically to 90 calendar
days before the cleanup date. In one bounded transaction it removes dismissed/invalidated proposals
and then movements older than the floor only when they have no payment and no pending or confirmed
proposal. Payment-linked and pending or confirmed movement evidence remains protected by the
booking retention lifecycle. Terminal runs and their cascading sanitized incidents are removed 90
days after completion; nonterminal work is never pruned.

The initial scan always honors the administrator's configured historical date. A floor advances
only after complete page exhaustion from the prior floor, never after an incomplete partial/failed
run. A run that exhausts pagination but is `PARTIAL` only because of item incidents may advance it;
its sanitized incidents remain available until operational-history pruning. This prevents a gap and
a deleted unmatched movement cannot be re-imported by the next normal scan.
The cleanup is registered in the existing scheduler and uses bounded batches; it adds no process,
service, secret, or provider request.

**Rationale**: The project retention policy identifies unmatched third-party bank data as the
shortest-lived financial records. A 90-day floor matches the default matching window, minimizes
personal narrative retention, and remains compatible with explicit historical first imports.

**Alternatives considered**:

- Retain every movement indefinitely: rejected because it conflicts with data minimization and the
  project retention policy.
- Delete old rows while continuing to scan from the immutable first-import date: rejected because
  the same provider movements would be re-imported on the next run.
- Advance the floor after an incomplete partial or failed scan: rejected because unprocessed
  movements could be skipped permanently.