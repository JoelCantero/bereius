# Feature Specification: Berea Booking Manager

**Feature Branch**: `20260909-project-specification`

**Created**: 2026-09-09

**Status**: Draft — open decisions pending

**Input**: Replace the n8n workflow "Crear presupuesto cuando se recibe un formulario de reserva, crear factura y actualizar contrato" with a web application.

## Overview

Berea is a summer camp house (*casa de colonies*). Booking requests arrive through a Gravity Forms
form on the WordPress site at `berea.cat`, gated by a WP Simple Booking Calendar availability check.
Today an n8n workflow reacts to that form: it looks up the customer in Holded by tax identifier,
asks a human for approval over email, and issues a quote.

That automation has no persistent state. The request lives only inside an n8n execution, approvals
happen through email links with no record of who decided what, a duplicate webhook creates duplicate
records in Holded, and a failure halfway through leaves an orphaned contact with no quote and nobody
aware of it.

This application replaces the workflow end to end. It becomes the system of record for booking
requests: every request is persisted, every state transition is attributable, and the operator works
from a screen instead of an inbox. n8n is retired completely.

## Goals

- Persist every booking request with a queryable lifecycle state.
- Move human approval from email links into an authenticated screen with a full audit trail.
- Detect incoming transfers automatically by reading the bank account, leaving the operator to
  confirm rather than to search.
- Keep Holded as the accounting system, driven idempotently from the application.
- Cover the complete commercial cycle: request, estimate, advance payment, confirmation, final
  invoice.

## Non-goals

- Owning availability. WP Simple Booking Calendar remains authoritative; the application pushes
  events into it once a booking is confirmed.
- Preventing concurrent requests for overlapping dates. See *Accepted risks*.
- Online payment collection. The advance arrives by bank transfer; the application detects it by
  reading the bank account, but never initiates or captures a payment.
- A customer-facing account area. Requesters never sign in; every interaction with them happens over
  email.

## Actors

| Actor | Description |
|---|---|
| Requester | Member of the public who submits the Gravity Forms booking request. Has no account. |
| Operator | Berea staff member who reviews, approves or rejects requests and confirms payment matches. |
| Administrator | Operator who can additionally manage users, integration settings and the bank connection. |
| System | Scheduled jobs handling intake polling, expiry, retries, calendar synchronisation and bank polling. |

Several users belong to the single organisation (Berea). The data model keeps an explicit
organisation boundary so a second house could be added later without restructuring, but multi-tenant
routing and isolation are out of scope for this version.

## Domain model

| Entity | Purpose |
|---|---|
| `Organisation` | Owning entity of every record. Single row for now. |
| `Customer` | Person or organisation identified by tax identifier (NIF/NIE/CIF). Mirrors a Holded contact. |
| `BookingRequest` | The core aggregate: dates, headcount, board type, lifecycle state, decision metadata. |
| `Quote` | Holded estimate issued on approval. Stores the Holded identifier, amount and payment deadline. It also serves as the contract: it carries the full booking detail, and the payment instructions live in its footer. |
| `Payment` | Recorded bank transfer covering the advance and the security deposit. |
| `BankConnection` | Enable Banking consent session: session identifier, connected accounts and expiry. |
| `BankTransaction` | Incoming credit read from the bank account, stored once, keyed by its entry reference. |
| `PaymentMatch` | Proposed link between a `BankTransaction` and a `BookingRequest`, with confidence and confirmation state. |
| `Invoice` | Holded invoice. Two kinds: the reserve invoice issued at approval and the closing invoice issued after the stay. |
| `CalendarEvent` | Block pushed to the WordPress calendar for a confirmed booking. |
| `AuditEvent` | Append-only record of every transition: actor, timestamp, previous and new state, reason. |
| `BookingMailSettings` | SMTP configuration for the booking mail channel, with the password encrypted at rest. |
| `IntegrationJob` | Outbox entry for an outbound Holded or calendar call, with attempt count and status. |

Board type is an enumeration: full board (*pensio completa*, `pc`) or self-catering (*dret a cuina*,
`dc`), matching the `Cuina` field of the current form.

## Lifecycle

```
                    ┌────────────┐
                    │  received  │  form submitted, stored, acknowledged
                    └─────┬──────┘
                          │ operator opens it
                    ┌─────▼──────┐
              ┌─────│ in_review  │─────┐
              │     └────────────┘     │
     approve  │                        │ reject (reason required)
              │                        │
        ┌─────▼──────┐           ┌─────▼──────┐
        │  approved  │           │  rejected  │
        └─────┬──────┘           └────────────┘
              │ estimate and reserve invoice issued in Holded
      ┌───────▼────────┐
      │ awaiting_payment│──── 3 days without payment ────▶ ┌─────────┐
      └───────┬─────────┘                                    │ expired │
              │ payment recorded                             └─────────┘
        ┌─────▼──────┐
        │ confirmed  │  calendar event pushed to WordPress
        └─────┬──────┘
              │ stay completed, invoice issued
        ┌─────▼──────┐
        │  invoiced  │
        └─────┬──────┘
              │
        ┌─────▼──────┐
        │ completed  │
        └────────────┘
```

`cancelled` is reachable from `approved`, `awaiting_payment` and `confirmed`, and always requires a
reason. Every transition writes an `AuditEvent`.

## Flow

### 1. Intake

The application reads submissions from the Gravity Forms REST API v2 **every hour**. There is no
inbound webhook: WordPress never calls the application, which removes the public endpoint, its
shared secret and its replay protection from the design entirely.

This is a deliberate reversal of the n8n arrangement, which relied on the Webhooks add-on pushing
each submission. A push has no reliable retry, so a submission arriving while the application is
deploying or unreachable is lost with nobody aware of it. Latency is not a concern here because the
next step is human review; nobody approves a booking within seconds of it arriving.

Mechanics:

- Entries are read in ascending identifier order, and the last processed identifier is stored as a
  cursor. Filtering by creation date instead would risk skipping entries whenever the WordPress and
  application clocks disagree.
- Fields are mapped by **field identifier**, not by label. The n8n webhook keys off labels such as
  `Nom`, `Codi postal` and `Telèfon`, so renaming a field in Gravity Forms breaks the mapping
  silently or produces a request with empty values.
- Each payload is validated with Zod and rejected if it does not match the schema. Rejected entries
  are recorded so a malformed submission is visible rather than skipped.
- Credentials for the Gravity Forms API are read through `src/lib/env.ts`.

The Gravity Forms entry identifier is the idempotency key: reprocessing the same entry resolves to
the same `BookingRequest` instead of creating a second one.

The requester receives an acknowledgement immediately, sent by Gravity Forms' own notification on
submission, so it does not wait for the next poll. The n8n workflow sent nothing until a human
acted, which left people uncertain for days.

### 2. Review

Operators see a queue of pending requests. The detail view shows the stay (dates, nights, headcount,
board type), the customer data as submitted, and whether a matching Holded contact already exists.

Approving or rejecting is a single action from that screen. Rejection requires a reason, which is
recorded and sent to the requester. In the n8n flow the rejection branch was never wired up, so a
rejected request silently disappeared.

### 3. Quote and reserve invoice

On approval the application, in order:

1. Looks up the Holded contact by tax identifier using the API filter, not by downloading the full
   contact list as the current workflow does.
2. Creates the contact when absent, or updates the email when it differs from the submission.
3. Resolves the rate (see *Pricing*) and issues the Holded estimate.
4. Asks Holded to send the estimate to the requester using the configured mail template.
5. Issues the reserve invoice derived from that estimate, covering the advance and the security
   deposit.
6. Rewrites the estimate lines so the advance and the deposit appear deducted, leaving the balance
   payable after the stay.
7. Stores the returned Holded identifiers on the `BookingRequest`.

Each step runs through the outbox: if Holded is unavailable the approval is still recorded and the
call is retried with backoff, rather than losing the decision. Steps are idempotent, keyed by the
booking request, so a retry never duplicates a contact, an estimate or an invoice.

This sequence is where the current workflow is most fragile. It performs four dependent Holded
calls with no transaction and no compensation: a failure at step 6 leaves an invoice issued against
an estimate that still shows the full amount, and nobody is notified.

## Email responsibilities

Commercial documents and operational notices travel by different paths, deliberately:

| Message | Sent by | When |
|---|---|---|
| Acknowledgement of receipt | Gravity Forms notification | On submission, before the application has seen the entry |
| Estimate and invoices | Holded, using its mail templates | On approval and after the stay |
| Booking confirmation | Application, over SMTP as `hola@berea.cat` | When an operator confirms the payment match |
| Rejection, cancellation, expiry notices | Application, over SMTP as `hola@berea.cat` | On the corresponding transition |
| Operator notifications | Application, over SMTP as `hola@berea.cat` | New request pending review, proposed payment match, consent about to expire |

Holded owns document delivery because the templates, branding and attachments already live there.
The acknowledgement stays in Gravity Forms so it reaches the requester immediately rather than
waiting for the next hourly poll. Everything that depends on application state — confirmation,
rejection, expiry — is sent by the application, because only it knows that the transition happened.

### Two independent mail channels

Account mail and booking mail are separate concerns and must not share configuration.

| Channel | Purpose | Transport | Configured in |
|---|---|---|---|
| Account | Sign-in links, access codes, account notices for operators | Existing HTTPS provider (Brevo) | Environment (`MAIL_*`) |
| Booking | Confirmation, rejection, cancellation, expiry, operator alerts | SMTP | Application settings |

Keeping them apart means a misconfigured booking mailbox can never lock operators out of the
application, and changing the public sender address does not require a redeploy.

### Booking mail settings

An administrator configures the booking channel from a settings screen: host, port, TLS mode,
username, password and the sender address, which is `hola@berea.cat`. A *send test message* action
validates the configuration before it is saved, so a wrong password surfaces immediately rather than
when the first confirmation fails to arrive.

The password is the sensitive part of this decision. It is stored encrypted at rest with a key held
in the environment, never returned to the browser once saved, never written to a log or an export,
and only replaceable, never readable. The settings screen shows whether a password is set, not what
it is.

Sending goes through the outbox rather than inline with the request that triggers it, because SMTP
holds a connection and is slower than an HTTPS call.

That address belongs to the mail server at `berea.cat`, which is already covered by its SPF and DKIM
records, so no DNS change is needed. The trade-offs are accepted deliberately:

- **No delivery analytics.** There is no equivalent of the provider event log used to diagnose
  bounces; the evidence lives in the mail server's logs.
- **Sending limits.** cPanel hosting caps messages per hour. Volume here is low, but the cap exists.
- **A second sending identity.** Booking mail leaves from the Berea mail server while account mail
  leaves through Brevo, so the two have independent reputations.

The consequence of Holded owning document delivery remains: the application has no visibility over
whether the estimate reached the customer. Those messages do not appear in its structured logs and
cannot be diagnosed with its own tooling. When a customer reports not receiving a quote, the answer
is in Holded.

The application records that delivery was requested, along with the Holded response, so at least the
handover point is auditable.

### 4. Payment and confirmation

The advance and the security deposit are payable within **three days** of approval. The reserve
invoice carries that same due date; the retired workflow issued it at seven days while the stated
rule was three, and the application uses a single figure for both.

While a request waits for payment the application polls the bank account and proposes matches for
incoming credits. An operator confirms the match, which moves the request to `confirmed`. On
confirmation the dates are blocked in the calendar and the requester receives a confirmation email.

A scheduled job expires requests that reach the deadline without a confirmed payment, which releases
the dates.

On confirmation the application publishes a calendar event so the dates are blocked in WP Simple
Booking Calendar. See *Calendar synchronisation*.

### 5. Final invoice

An operator raises the closing invoice for the outstanding balance when the stay ends. This is a
deliberate human step, not a scheduled job: the operator confirms that the stay ran as booked with
no changes to headcount or dates, and that the house was left in a condition that allows the
security deposit to be returned.

There is no separate contract document. The estimate itself plays that role: it states the full
booking detail and its footer carries the instructions for paying the advance.

## Pricing

Pricing is driven by Holded services rather than by a rate table in the application. The rules below
are recovered from the retired workflow.

### Billable quantity

```
nights   = endDate - startDate
billable = max(headcount, 30)        minimum 30 places
units    = nights x billable         (person-nights)
```

The house bills a floor of 30 places. A group of 22 staying two nights is invoiced 60 person-nights,
not 44. The retired workflow multiplied by the exact headcount submitted and therefore under-billed
every group below 30.

### Rate selection

A service SKU is derived from board type and headcount band, then mapped to a Holded service
identifier:

| Headcount | SKU suffix |
|---|---|
| up to 39 | `30` |
| 40 to 59 | `40` |
| 60 to 79 | `60` |
| 80 or more | `80` |

The prefix is the board type: `dc` (self-catering) or `pc` (full board). A group of 45 on full board
resolves to `pc40`. Eight services exist, one per combination.

Rates per person and night, as published:

| Board type | 30-39 | 40-59 | 60-79 | 80+ |
|---|---|---|---|---|
| Self-catering (`dc`) | 18 EUR | 16 EUR | 15 EUR | 13 EUR |
| Full board (`pc`) | 34 EUR | 32 EUR | 30 EUR | 29 EUR |

This table is documentation only. The authoritative price is read from the Holded service at quote
time, so a rate change in Holded takes effect without touching the application.

A small set of customers, identified by tax identifier, is billed against a single negotiated
service regardless of headcount and board type. In the workflow this list is hardcoded in an
expression; in the application it becomes customer data, not logic.

The unit price is read from the Holded service. The application never stores prices.

### Amounts due

Two distinct concepts, which the original workflow keeps separate and which must not be conflated:

| Concept | Amount | Nature |
|---|---|---|
| Advance (*bestreta*) | 30% of `unit price x units`, VAT included at 10% | Payment on account, deducted from the final balance |
| Security deposit (*diposit*) | 200 EUR, fixed | Refundable after the stay if the house is left in order |

The amount required to confirm a booking is the sum of both, payable within three days of approval.
The estimate is then rewritten with both as negative lines, so it displays the balance still owed.

The deposit is refunded within seven working days of the stay ending.

### Monetary handling

Amounts are held as integer minor units or an exact decimal type, never as floating point. The
workflow computes `subtotal = amount / 1.10` in JavaScript numbers, which produces values such as
`1963.6363636363637` and leaves rounding to Holded. The application rounds explicitly at a defined
precision before sending.

## Calendar synchronisation

The application publishes a read-only iCalendar feed containing one `VEVENT` per confirmed booking.
WP Simple Booking Calendar subscribes to that URL through *Import from iCal URL*.

The plugin treats an imported feed as an overlay rendered on top of the calendar rather than as
stored dates, so the feed is the sole description of application-owned blocks. Removing an event
from the feed releases the dates on the next refresh, which makes cancellation and expiry work
without any additional call.

Constraints this imposes:

- **The feed URL is fetched unauthenticated.** It must therefore contain no personal data: no names,
  no email addresses, no tax identifiers. Each event carries a neutral summary and nothing else.
  The URL itself includes an unguessable segment to discourage casual discovery, which is
  obfuscation rather than access control.
- **Every event needs a stable `UID`** derived from the booking identifier, so repeated refreshes
  reconcile instead of duplicating.
- **`DTEND` is exclusive for all-day events.** The departure day is released to the next group, so
  the block covers arrival day through the last night only and `DTEND` is the departure date itself.
  Nights blocked and nights billed therefore match.
- **The feed is generated from current state on every request**, never incrementally maintained, so
  it cannot drift away from the database.

## Bank reconciliation

The application reads the Berea bank account through Enable Banking, an account information service
under PSD2, to detect the transfers that confirm bookings. It has read access only: it can never
move money.

### Connecting the account

An administrator connects the account once from the settings area:

1. The application signs an RS256 JWT with its Enable Banking private key, using the application
   identifier as `kid`, `enablebanking.com` as issuer and `api.enablebanking.com` as audience.
2. `POST /auth` returns the bank authorisation URL. The administrator follows it and authenticates
   at the bank.
3. The bank redirects back with a `code`. The application **validates the `state` parameter against
   the value it generated** before doing anything else.
4. `POST /sessions` exchanges the code for a session identifier and the list of accounts.
5. The session, its accounts and its expiry are persisted as a `BankConnection`.

The retired workflow skipped step 3 entirely — its own notes admit it, and the two configuration
nodes even carry different `state` values. An unvalidated callback lets an attacker complete the
flow with a consent of their choosing.

### Consent lifetime

PSD2 consents expire; the workflow requests 180 days. An expired consent silently stops
reconciliation, so the application tracks the expiry date, warns administrators in advance, and
surfaces the connection state in the settings area. A booking must never sit unconfirmed because
nobody noticed the bank link had lapsed.

### Matching

While any request is in `awaiting_payment`, a scheduled job runs **every six hours** and fetches
recent credits. Each is stored once, keyed by its bank entry reference, so repeated polling never
duplicates or re-matches. When nothing is awaiting payment the job does not run at all.

A credit is matched on two conditions, both required:

1. **The transfer reference contains the estimate identifier.** The estimate footer instructs the
   customer to quote it, and it is the same identifier that names the contract.
2. **The amount equals the expected total exactly** — the advance plus the 200 EUR deposit, to the
   cent.

Anything else goes to manual review: a credit whose reference is missing or unreadable, a partial
payment, an overpayment, or two transfers that only cover the total between them. These appear in a
list of unmatched credits rather than being discarded, and an operator resolves them by hand.

Proposals are never applied automatically. The operator receives an email, opens the request and
confirms or dismisses the match. The audit trail records who confirmed it and against which bank
transaction. Automated matching narrows the search; a person still decides.

### Expiry and polling cadence

A six-hour cadence against a three-day deadline leaves roughly twelve opportunities to see a
payment, but it also means a transfer arriving shortly before the deadline may not have been read
yet when the expiry job runs. The expiry job therefore polls once more before expiring anything, so
a booking is never released while a valid payment sits unread.

### Security and data protection

- The Enable Banking private key is a secret read through `src/lib/env.ts`. It is never persisted in
  the database, never logged, and never included in an export. In the retired workflow it sat in
  clear text inside the workflow definition, which is how it ended up in an exported file.
- Session identifiers are credentials and are treated as such.
- Bank transactions carry third-party personal data, including payer names. Only the fields needed
  for matching are stored, and they fall under the retention policy below.
- The callback endpoint validates `state`, accepts a code once, and is rate limited.

## Requirements

### Functional

- Every request is persisted before any external call is attempted.
- Every state transition records actor, timestamp, previous state, new state and reason.
- Intake is idempotent per Gravity Forms entry identifier, and the cursor advances only after the
  entry is committed.
- Outbound Holded and calendar operations are idempotent per booking request and retried on failure.
- Rejection, cancellation and expiry all notify the requester. Confirmation does too.
- Bank transactions are stored once, keyed by entry reference, and a transaction can back at most one
  confirmed payment.
- Payment matches are proposed automatically and confirmed by a person, never applied silently.
- A match requires both the estimate identifier in the transfer reference and an exact amount;
  everything else is queued for manual review.
- Operators can filter requests by state and search by customer, tax identifier and date range.

### Non-functional

- All untrusted input validated with Zod at the boundary.
- Holded, Gravity Forms and Enable Banking credentials read through `src/lib/env.ts`; never logged.
- Booking SMTP credentials stored encrypted at rest, write-only from the settings screen, excluded
  from logs and exports.
- Personal data (tax identifier, address, phone) redacted in structured logs.
- Booking data anonymised on the schedule in *Data retention*.
- Interface localised in Catalan, Spanish and English through the existing `next-intl` setup.

## Data retention

Requesters have no account, so the storage limitation principle is enforced by a scheduled job
rather than by a self-service action.

| Category | Period | Rationale |
|---|---|---|
| Rejected and expired requests | 12 months from the decision | No contractual relationship exists; the window covers a complaint or a repeat enquiry from the same group |
| Completed bookings | 6 years from the end of the stay | Covers the four-year tax limitation period, the five-year period for contractual claims, and the six years required for commercial records |

Records are anonymised rather than deleted. Name, tax identifier, email, phone and address are
removed; dates, headcount, board type and amounts are kept, so occupancy history survives without
personal data.

Bank transactions are kept only while they can still be matched, and are pruned once the booking
they back reaches its own retention limit. Unmatched credits belonging to third parties are the
shortest-lived records in the system.

The application is not the accounting system. Invoices live in Holded under its own retention rules,
which is what allows these periods to be this short.

A requester exercising the right to erasure is handled manually; there is no self-service path,
because there is no customer account.

## Accepted risks

**Overlapping requests.** Two requests for the same dates can both be submitted and approved. The
availability check in WordPress only runs at submission time, and the application does not place a
hold. The three-day deposit deadline is the mitigation: unpaid requests expire and release
themselves. This is a deliberate deferral, not an oversight, and it is revisited if double bookings
occur in practice.

**Calendar propagation delay.** The plugin caches imported feeds and refreshes them hourly by
default, so a confirmed booking can remain bookable on the public calendar for up to an hour. This
widens the window for the overlap above. The refresh interval is configurable in the plugin
settings, and the cache can be cleared manually, but the application cannot force a refresh.

## Migration from n8n

The workflow is switched off once the application handles intake. These defects are not carried
over:

- **Fractional nights across daylight saving changes.** Nights are computed by subtracting two
  `Date` values and dividing by 86 400 000. A stay spanning a clock change yields 2.0417 nights, and
  since billable units are `nights x headcount`, the estimate is issued with fractional quantities.
  Date arithmetic must be calendar-based, not millisecond-based.
- **Missing minimum billable headcount.** Groups below 30 are billed for their exact size instead of
  the 30-place floor.
- **Unquoted `language: ca`** in the contact defaults, which throws at runtime.
- **Unpaginated full contact download** used for tax identifier lookup.
- **Negotiated-rate customers hardcoded in an expression.** Two tax identifiers are embedded in the
  workflow. This is customer data and belongs in the database.
- **Floating point money.** See *Monetary handling*.
- **Unconnected rejection branch**, which discards rejections silently.
- **Unvalidated OAuth `state` in the bank callback**, acknowledged in the workflow's own notes, with
  inconsistent values between the two configuration nodes.

Credentials and personal data present in the exported workflows must not reach this repository: the
Basic Auth credential on the webhook — which the pull-based intake makes unnecessary — the **Enable
Banking RSA private key**, the bank account number, the Holded account identifiers, and the pinned
execution data containing real customers' names, tax identifiers, addresses and email addresses. The
Basic Auth credential and the Enable Banking key pair must be rotated regardless, since both were
exported in clear text.

## Delivery phases

The work ships in four phases, each independently useful and independently verifiable.

### Phase 1 — Booking pipeline

Schema and lifecycle, hourly intake from Gravity Forms, operator roles, the review queue with
approve and reject, the audit trail, the Holded sequence (contact, estimate, reserve invoice) behind
the outbox, the booking mail settings screen, and the booking notifications. Payment is recorded by
hand: an operator marks the transfer as received.

Review and quoting cannot be split across phases. If the application owned review while n8n still
issued quotes, every request would need approving twice — once on screen and once by email — so the
cut-over happens in one step.

**Exit criterion**: n8n is switched off and no booking depends on it.

### Phase 2 — Bank reconciliation

The Enable Banking connection, consent expiry monitoring, six-hourly polling, match proposals and
operator confirmation. Replaces the manual payment recording from phase 1, which remains available
as the fallback for unmatched credits.

**Exit criterion**: a transfer quoting the estimate identifier produces a proposal without anyone
opening the bank.

### Phase 3 — Calendar synchronisation

The iCalendar feed and its subscription from WP Simple Booking Calendar.

**Exit criterion**: confirming a booking blocks the dates on the public calendar within the plugin's
refresh interval, and cancelling releases them.

### Phase 4 — Closing the cycle

The final invoice raised by an operator when the stay ends, the deposit refund, and the scheduled
anonymisation job implementing the retention policy.

**Exit criterion**: a booking can be taken from submission to anonymisation without leaving the
application.

## Open decisions

None outstanding.
