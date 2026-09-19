# Contract: Holded Treasury Read API

**Status**: Success response and pagination verified against anonymized real data on 2026-09-16;
error bodies intentionally remain unverified and opaque

**Base URL**: `https://api.holded.com/api/v2`

**Authentication**: Existing Bereius `HOLDED` Bearer credential, resolved server-side from encrypted
integration settings. The value never enters a URL, response, log, fixture, or planning artifact.

All calls use `GET`, `Accept: application/json`, the existing 15-second timeout, `cache: no-store`,
a bounded response body, and sanitized provider error mapping. No treasury write method is in scope.

## List Treasury Accounts

```http
GET /treasury/accounts?limit=100[&cursor=<opaque>]
```

The account selector follows the observed v2 envelope until `has_more=false`. Only non-archived
accounts are selectable.

### Accepted Response Shape

```text
object
|-- items: array<object>
|   |-- id: non-empty string (observed: 24 hex)
|   |-- name: non-empty string
|   |-- currency: uppercase three-letter string (observed: EUR)
|   `-- archived: boolean
|-- has_more: boolean
`-- cursor: string | null
```

Unknown account fields are stripped. In particular, the adapter never returns account number,
accounting account, balance, BIC, creditor ID, IBAN, institution data, issuer ID, synchronization
time, reconciliation count, or account type.

The initial feature permits selection only of a non-archived account whose reported currency is
`EUR`. Other account currencies are not evidence-backed movement contracts and are ineligible until
renewed anonymized verification.

### Domain Projection

```text
HoldedTreasuryAccountOption
|-- id: string
|-- name: string
|-- currency: string
`-- archived: boolean
```

## List Bank Movements

```http
GET /treasury/accounts/{id}/bank-movements?start_date=YYYY-MM-DD&limit=100[&cursor=<opaque>]
```

### Request Validation

| Input | Contract |
|---|---|
| `{id}` | Exactly 24 hexadecimal characters and equal to the configured account. |
| `start_date` | Valid non-future calendar date fixed for the entire run. |
| `limit` | Constant `100`; empirically returned 100 items. |
| `cursor` | Opaque non-empty value from the immediately preceding page; never parsed or logged. |

`since`, `from`, `date_from`, and `since`/`until` are not aliases: real probes showed that Holded
ignored them. The implementation MUST use `start_date`.

### Accepted Page Shape

```text
object
|-- items: array<HoldedBankMovementItem>
|-- has_more: boolean
`-- cursor: string | null
```

Page invariants:

- `has_more=true` requires a non-empty cursor not seen earlier in the current attempt.
- `has_more=false` is the only successful terminal condition.
- A malformed envelope, missing cursor, repeated cursor, oversized body, or failed page is not an
  empty result and not successful exhaustion.
- `start_date` and `limit=100` are repeated with every cursor request.
- A safety/time budget may yield and continue from the committed cursor, but MUST NOT mark the run
  successful or omit remaining pages.

### Accepted Item Shape

```text
HoldedBankMovementItem
|-- id: string
|-- banking_account_id: string
|-- booking_date: string
|-- value_date: string | null | absent
|-- description: string | null | absent
|-- amount: string
|-- currency: string
`-- status: string | null | absent
```

Unknown item fields are stripped. The current real response also contained
`accounting_amount`, `accounting_currency`, `balance`, `flagged_at`, `note`, `origin`, and
`reconciled_amount`; all are intentionally discarded.

### Field Validation and Mapping

| Provider field | Validation | Domain result |
|---|---|---|
| `id` | 24 hexadecimal characters | `holdedMovementId` |
| `banking_account_id` | Exactly equals requested account ID | account relation |
| `booking_date` | ISO datetime with explicit `Z` or numeric offset | leading calendar date |
| `value_date` | Same date validation when present | optional leading calendar date |
| `description` | Trimmed, at most 2,000 characters | optional `narrative` |
| `amount` | Strict signed decimal with exactly two fractional digits, non-zero | signed integer `amountMinor` |
| `currency` | Literal `EUR` for the initial verified contract | `currency` |
| `status` | Trimmed, at most 64 characters | optional `providerStatus` |

The first real page contained positive and negative dot-decimal amounts with two fractional digits,
`EUR`, and statuses `pending` and `reconciled`. These observed values do not justify rejecting a
future otherwise-valid status string.

### Direction Contract

The verified endpoint exposes no credit/debit indicator. For the current contract:

```text
amountMinor > 0  => INCOME
amountMinor < 0  => EXPENSE
amountMinor = 0  => ZERO_AMOUNT incident; no movement/totals/proposal
```

Description, status, note, origin, and other words never influence direction. A future provider
direction field requires renewed anonymized evidence before the adapter recognizes it.

### Narrative Contract

The endpoint exposes no distinct reference or counterparty. The one retained narrative has these
domain projections:

```text
concept      = narrative
reference    = narrative
counterparty = null
```

No name/reference extraction or bank-specific string split is allowed.

## Pagination Evidence

| Probe | Verified result |
|---|---|
| Default first page | 50 items, `has_more=true`, cursor present |
| Cursor page 2 | HTTP 200, 50 items, different ID sequence, zero overlap |
| `limit=1` | HTTP 200, exactly 1 item |
| Unfiltered exhaustion | 56 pages, terminal reached, zero duplicate IDs |
| 90-day `start_date`, `limit=100` | 100 items then 25, terminal reached, zero overlap |
| Future `start_date` | HTTP 200, zero items |

No production identifier, cursor, date, amount, or narrative from these probes is retained.

Provider item ordering was not recorded or established as stable. The importer treats each page as
an unordered batch, uses only the opaque cursor for continuation, and applies deterministic local
ordering for queries and display.

## Conservative Error Mapping

No live non-200 body shape was captured. The adapter therefore does not parse provider error bodies
or assume provider error fields or enums. It maps only transport outcomes and HTTP status, discards
the bounded body, and uses success-schema validation only for 2xx responses.

| Provider/transport outcome | Domain code | Retry |
|---|---|---:|
| Network error, timeout, 5xx | `PROVIDER_UNAVAILABLE` | yes |
| 429 | `PROVIDER_RATE_LIMITED` | yes, bounded backoff |
| 401/403 | `PROVIDER_UNAUTHORIZED` | no until configuration changes |
| 404 | `PROVIDER_NOT_FOUND` | no until account configuration changes |
| 400/422 | `PROVIDER_REQUEST_REJECTED` | no automatic loop |
| 2xx non-JSON or schema mismatch | `MALFORMED_PAGE` | no automatic loop |
| Oversized response | `RESPONSE_TOO_LARGE` | no automatic loop |

Provider response bodies and messages are never copied into errors, incidents, or logs.

## Provider Contract Tests

- Unit fixtures use only synthetic values and the exact observed field names.
- Page tests prove missing/repeated cursor is partial failure, not exhaustion.
- Parser tests cover positive, negative, zero, malformed, excessive precision, non-`EUR` currency,
  account mismatch, malformed date, absent optional fields, and unknown-field stripping.
- HTTP tests assert method/path/query/header shape and that no treasury write request can be made.
- Synthetic HTTP tests cover each status category with arbitrary or malformed bodies and prove that
  no provider body or message changes the domain mapping or reaches logs, incidents, or user output.
- Tests mock the established HTTP boundary; CI never calls live Holded.