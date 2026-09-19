# Contract: Bank Movements UI and Actions

## Route and Access

| Concern | Contract |
|---|---|
| Localized route | `/bank-movements`, `/es/bank-movements`, `/ca/bank-movements` |
| Page access | Active `OPERATOR` or `ADMINISTRATOR`, checked from session plus database |
| Account configuration | Active `ADMINISTRATOR` only |
| Indexing | Private/transient: `noindex`, no sitemap entry |
| Data loading | Server Component calls banking query service directly |
| Interactivity | Small client islands for filter controls, sync progress, confirm/dismiss forms |

Signed-out users go to the localized login route with
`callbackUrl=/bank-movements`. An authenticated but unauthorized user receives the existing safe
console fallback; role/account information never comes from form or query input.

## Navigation

Add a localized **Bank movements** link under the existing Holded console section for both operator
roles. Keep treasury account configuration in the existing administrator-only integrations page.

## Filter Query Contract

```text
GET /[locale]/bank-movements
  ?direction=all|income|expense
  &from=YYYY-MM-DD
  &to=YYYY-MM-DD
  &account=<24-hex-provider-account-id>
  &currency=<ISO-4217>
  &q=<text>
  &page=<positive-integer>
```

All parameters are optional and server-validated.

| Parameter | Default | Validation/behavior |
|---|---|---|
| `direction` | `all` | Exact enum; maps to stored direction when not `all`. |
| `from` | absent | Valid inclusive bank calendar date. |
| `to` | absent | Valid inclusive bank calendar date; must not precede `from`. |
| `account` | all retained accounts | Valid 24-hex account represented by an authorized projection. |
| `currency` | all | Uppercase code present in retained rows. Current provider ingestion accepts only `EUR`; grouping remains future-compatible. |
| `q` | empty | Trim/collapse whitespace, max 100 characters, case-insensitive narrative contains. |
| `page` | `1` | Positive integer; 50 rows per page. |

Invalid filters produce a localized validation notice and no unbounded query. Applying or clearing a
filter resets `page=1`. All active filters combine with logical AND.

## Server Projection

```text
BankMovementsPage
|-- rows: BankMovementRow[]
|-- totalRows: integer
|-- page: integer
|-- pageSize: 50
|-- totals: CurrencyTotals[]
|-- accounts: AccountFilterOption[]
|-- currencies: string[]
|-- latestRun: BankSyncRunSummary | null
|-- latestSuccessfulAt: datetime | null
|-- incidents: BankSyncIncidentSummary[]
`-- pendingProposalCount: integer

BankMovementRow
|-- id: local movement ID
|-- date: YYYY-MM-DD
|-- valueDate: YYYY-MM-DD | null
|-- concept: string | null
|-- reference: string | null
|-- counterparty: null
|-- account: { id: provider account ID, name: display name }
|-- amountMinor: decimal-string serialization of signed BigInt
|-- currency: ISO code
|-- status: string | null
|-- direction: income | expense
`-- proposals: authorized minimal proposal summaries

CurrencyTotals
|-- currency: ISO code
|-- incomeMinor: non-negative decimal string
`-- expenseMinor: non-negative absolute decimal string
```

List rows are ordered by `bookingDate DESC`, then provider movement ID for a deterministic tie.
Totals are grouped and summed by currency plus direction over every matching valid movement, not
only the current 50-row page. No conversion or cross-currency grand total exists.

## Presentation States

| State | Required presentation |
|---|---|
| Initial load | Existing console loading convention; stable table dimensions. |
| Empty | Localized empty result for current filters, with clear-filter action when applicable. |
| `QUEUED` | Refresh accepted and waiting; button disabled; polite live status. |
| `RUNNING` | Pages/items and inserted/updated/incident counts; periodic route refresh. |
| `RETRYING` | Partial progress retained, sanitized reason, next retry indication. |
| `SUCCEEDED` | Completion time, counts, updated latest-success time. |
| `PARTIAL` | Committed progress remains visible, but exhaustion was not proven or item incidents occurred; show an incident summary and explicit retry control. |
| `FAILED` | No provider page committed; existing rows from earlier runs remain visible with a sanitized category and explicit retry control. |

Every row includes visible **Income** or **Expense** text and accessible semantics in addition to
styling. Negative/positive signs remain visible. Missing optional concept/counterparty/status/value
date uses one neutral localized empty label rather than fabricated data.

For a configured account, the integration is degraded when the latest run is `RETRYING`, `PARTIAL`,
or `FAILED`, or when no run is active and `lastSuccessfulAt` is absent or more than six hours old.
An initial `QUEUED`/`RUNNING` run is pending rather than stale. No configured account is a distinct
setup state, not a provider outage.

The client polls with `router.refresh()` while the latest run is nonterminal and stops at terminal
state or component unmount. No provider credential, cursor, raw error, or hidden movement payload is
sent to the client.

## Manual Sync Action

```text
requestBankSyncAction(previousState, formData)
```

### Input

No actor, role, account ID, cursor, or start date is accepted from the browser. The server resolves
the current actor and active account.

An optional `retryRunId` may identify a terminal `PARTIAL`/`FAILED` run for the same active account;
it is a local cuid and is re-authorized server-side.

### Result Union

```text
{ status: "accepted", runId: string }
{ status: "already_running", runId: string }
{ status: "error", reason:
    "unauthenticated" |
    "forbidden" |
    "not_configured" |
    "rate_limited" |
    "invalid" |
    "unknown" }
```

Behavior:

- Require an active operator/administrator from the database.
- Apply a database-backed cooldown and return the existing nonterminal run when present.
- Create durable work before returning `accepted`.
- Never call Holded inside the action request.
- Revalidate the movement and settings routes after enqueue.
- Log only action outcome, actor ID, run ID, and local account row ID.

## Treasury Account Configuration Action

Located on the existing integrations page as a banking-owned form.

```text
saveTreasuryAccountAction(previousState, formData)
```

### Input

| Field | Validation |
|---|---|
| `holdedAccountId` | Required 24-hex ID from the freshly fetched, non-archived account options. |
| `importStartDate` | Required valid non-future date for a never-synchronized account. |

The action requires `ADMINISTRATOR`, resolves the existing encrypted Holded credential, re-fetches
the account list, and matches the submitted ID. The matched account must be non-archived and report
`EUR` under the initial verified contract. Display name/currency always come from the trusted
provider result, never hidden fields.

### Result Union

```text
{ status: "saved" }
{ status: "error", reason:
    "unauthenticated" |
    "forbidden" |
    "invalid" |
    "not_configured" |
    "account_unavailable" |
    "start_date_locked" |
    "connection" |
    "unknown" }
```

Saving makes the selected account active transactionally, preserves historical accounts/movements,
queues its first due synchronization, and never modifies the Holded credential.

## Integration Degradation and Application Health

A stale, retrying, partial, or failed banking run is presented only to authorized users and emitted
through sanitized structured operational signals. It does not change the existing application
health endpoint while the process and PostgreSQL are healthy. Production-artifact tests simulate a
Holded outage and assert all three outcomes together: prior movements remain visible, an unrelated
booking action succeeds, and `/api/health` remains HTTP 200 while this page shows degradation.

## Localization and Accessibility

- Add all labels, filters, direction/status text, result summaries, incident messages, settings
  copy, and errors to English, Spanish, and Catalan catalogs together.
- Every field has an associated label; filters and actions are keyboard-operable with visible focus.
- Sync/action feedback uses `role=status` for progress/success and `role=alert` for failures.
- Direction never relies only on color. Icons, if used, are decorative beside localized text.
- Tables retain semantic headers; the compact mobile presentation preserves field labels.
- Focus moves to a validation summary after invalid filters/settings and remains on the initiating
  control for background progress.

## UI Contract Tests

- Operator/admin access, signed-out localized callback, and admin-only account configuration.
- All filter combinations, inclusive dates, reset behavior, deterministic order, and 50-row paging.
- Totals over the full filtered set, separated by currency and direction.
- Empty/loading/queued/running/retrying/success/partial/error rendering with retained stale rows.
- Manual request de-duplication, cooldown, retry, accessible announcements, keyboard operation, and
  non-color direction text.
- `noindex` metadata, explicit exclusion of all localized movement paths from the sitemap, robots
  behavior that permits HTML `noindex`, three locale routes/copy, and production-artifact E2E.