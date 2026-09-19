# Feature Specification: Holded Bank Movements

**Feature Branch**: `20260916-holded-bank-movements`

**Created**: 2026-09-16

**Status**: Draft

**Input**: Replace Enable Banking with read-only Holded bank movements as the sole source for
movement visibility and booking-payment reconciliation.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Import Reliable Bank Movements (Priority: P1)

An administrator selects the Holded treasury account and the initial import date. Bereius then
imports every available movement, classifies valid movements by money direction, and keeps the
local records current without creating duplicates.

**Why this priority**: Complete, idempotent local data is the foundation for both operational
visibility and reliable payment reconciliation.

**Independent Test**: Configure an account against an anonymized multi-page provider response,
run the synchronization repeatedly with new, unchanged, corrected, and malformed movements, and
verify the resulting movements, classifications, incidents, and safe progress point.

**Acceptance Scenarios**:

1. **Given** an account with no prior import and no custom start date, **When** its first
   synchronization runs, **Then** movements from the preceding 90 days are considered and every
   available page is processed.
2. **Given** valid positive and negative movements, **When** they are imported, **Then** each is
  stored once and classified respectively as income or expense from the signed amount.
3. **Given** a movement whose descriptive text or status suggests a direction different from its
  signed amount, **When** it is imported, **Then** the signed amount remains authoritative and no
  descriptive word affects classification.
4. **Given** movements already imported for an account, **When** the same data is synchronized
   again, **Then** no duplicate is created.
5. **Given** Holded changes the information or status of an imported movement that remains inside
  the active synchronization window, **When** it is seen again, **Then** the existing local
  movement is updated.
6. **Given** a zero amount, invalid currency, or movement lacking required identity, date, amount,
  or account association, **When** it is processed, **Then** it is excluded from totals and
   reconciliation and a sanitized synchronization incident is recorded.

---

### User Story 2 - Find and Understand Movements (Priority: P1)

An authorized operator or administrator opens a private bank-movements view, quickly narrows the
list to the relevant records, and sees income and expense totals for exactly that filtered set.

**Why this priority**: Staff need a trustworthy, searchable view to investigate transfers and
support booking-payment decisions.

**Independent Test**: Load a known set spanning multiple dates, accounts, currencies, directions,
and statuses; exercise every filter alone and in combination and compare the rows and totals with
the expected set.

**Acceptance Scenarios**:

1. **Given** imported movements, **When** the view opens, **Then** it shows newest dates first and
   displays date, concept, counterparty, account, amount, currency, status, and textual
   classification.
2. **Given** a mixed movement set, **When** the user applies direction, date interval, account,
   currency, and text filters, **Then** only movements satisfying all active filters are shown.
3. **Given** filtered movements in more than one currency, **When** totals are displayed, **Then**
   income and expense totals are separate and no total combines currencies.
4. **Given** income and expense rows, **When** they are perceived without color, **Then** visible
   text and accessible semantics still distinguish their directions.
5. **Given** no records, an in-progress load, a partial synchronization, or a failed latest
   synchronization, **When** the view renders, **Then** it shows the corresponding state while
   retaining access to previously imported data.

---

### User Story 3 - Reconcile Booking Payments (Priority: P1)

An operator reviews strict match proposals or the wider candidate list on an awaiting-payment
booking, then manually confirms or dismisses one imported Holded income movement. Confirmation
records the money actually received and starts reserve-invoice issuance.

**Why this priority**: Holded must replace the retired bank source without weakening the deliberate
human confirmation step or allowing outgoing money to appear as customer payment.

**Independent Test**: Supply exact, near, boundary, and out-of-range income movements plus an equal
expense, then verify strict proposals, the inclusive booking candidate range, explicit confirmation,
the recorded amount, and idempotent reserve-invoice issuance without making any real provider write.

**Acceptance Scenarios**:

1. **Given** an income whose reference contains the estimate identifier and whose amount exactly
   equals the expected booking total, **When** reconciliation evaluates it, **Then** it can produce
   a proposal for operator review.
2. **Given** an expense with the same reference and amount, **When** reconciliation evaluates it,
   **Then** it never produces a proposal.
3. **Given** an otherwise valid income that fails either the existing reference rule or exact
  amount rule, **When** automatic reconciliation evaluates it, **Then** no automatic proposal is
  introduced.
4. **Given** a booking in `AWAITING_PAYMENT`, **When** its detail is opened, **Then** it lists
  unlinked EUR income dated on or after the estimate creation date whose amount is within an
  inclusive 5% below or above the expected advance-plus-deposit total, even when its concept has no
  estimate reference.
5. **Given** several eligible booking candidates, **When** they are ordered, **Then** a literal
  estimate reference improves rank but never determines eligibility; absolute amount difference,
  date, and stable provider identity resolve the remaining order deterministically.
6. **Given** an operator explicitly confirms an eligible candidate, **When** the transaction
  commits, **Then** the actual bank amount is stored as the payment, the booking is confirmed and
  audited, sibling candidates are invalidated, and one reserve-invoice job is queued atomically.
7. **Given** a confirmed bank-backed payment, **When** reserve-invoice processing runs, **Then** it
  creates or safely reuses one compatible invoice for the agreed advance and deposit, approves it,
  and sends it to the frozen fiscal-primary and delegate-copy recipients.
8. **Given** a proposal or candidate, **When** no operator has confirmed it, **Then** the booking
  remains unreconciled and no reserve invoice is issued.

---

### User Story 4 - Control and Recover Synchronization (Priority: P2)

An authorized operator requests an immediate refresh and can see its progress, result, latest
successful synchronization time, partial outcomes, and retryable errors without disrupting other
Bereius functions.

**Why this priority**: Scheduled imports cover normal operation, while transparent manual recovery
lets staff handle time-sensitive payments and provider outages.

**Independent Test**: Start successful, concurrent, interrupted, malformed-page, and unavailable-
provider runs and verify status visibility, idempotency, safe resume behavior, and continued access
to existing data and unrelated workflows.

**Acceptance Scenarios**:

1. **Given** a configured account and an authorized operator, **When** a manual refresh is
   requested, **Then** progress is visible until a success, partial, or error result is shown with
   the relevant synchronization timestamps.
2. **Given** another synchronization is already active for the account, **When** a second trigger
   arrives, **Then** it does not create a competing import or duplicate data and reports the active
   run.
3. **Given** processing succeeds through part of the provider result and then fails, **When** the
   run ends, **Then** its result is partial and its safe progress point does not move beyond the
   last movement processed successfully.
4. **Given** Holded is unavailable, **When** synchronization fails, **Then** existing movements stay
   queryable, unrelated application functions continue, and an authorized user can retry.
5. **Given** the interrupted source becomes available again, **When** synchronization is retried,
   **Then** it resumes safely and reaches a complete result without loss or duplication.

### Edge Cases

- A page is empty while provider pagination still advertises another page.
- Pagination repeats a page or continuation value and would otherwise loop forever.
- The provider changes a movement after it has already participated in a proposal.
- Descriptive text or provider status appears to imply a direction that conflicts with the signed
  amount; the signed amount remains authoritative.
- A movement has a valid identity and amount but omits optional value date, concept, reference,
  counterparty, or status information.
- Two configured accounts expose the same provider movement identifier at different times.
- An administrator changes the configured account after historical movements have been imported.
- A user supplies an inverted or otherwise invalid date interval.
- Text contains diacritics, mixed case, or surrounding whitespace.
- A manual refresh is requested immediately before or during the six-hour scheduled run.
- Holded returns a rate-limit response, transient server error, malformed item, malformed page, or
  an ambiguous pagination terminator.
- A run imports valid items and encounters invalid items in the same page.
- A candidate amount is exactly 5% below or above the expected total.
- Two operators confirm the same movement or booking concurrently.
- Holded refuses invoice creation definitively, returns an invoice identifier but no number, or
  leaves creation or delivery outcome uncertain after the request was sent.
- A reserve invoice already exists in Holded but its contact, total, lines, service/account mapping,
  quantity, or tax treatment differs from the agreed booking values.

## Requirements *(mandatory)*

### Functional Requirements

#### Source and Configuration

- **FR-001**: Holded MUST be the sole source of bank movements and reconciliation candidates;
  Bereius MUST cease importing or reconciling movements from Enable Banking.
- **FR-002**: The Holded treasury adapter MUST be read-only and limited to retrieving bank movements
  for the configured treasury account; banking synchronization MUST NOT create, modify, delete,
  pay, or transfer anything in Holded. Booking document operations remain a separate boundary.
- **FR-003**: The integration MUST reuse the Holded credential already managed by Bereius and MUST
  NOT introduce a second Holded credential for bank movements.
- **FR-004**: Administrators MUST be able to configure an eligible Holded treasury account
  identifier and the start date used when that account has no prior successful import. Under the
  verified initial contract, only a non-archived account reporting `EUR` is eligible.
- **FR-005**: The default first-import start date MUST be 90 calendar days before the first import,
  while allowing an administrator to choose another valid past date.
- **FR-006**: Only administrators MUST be allowed to change the account or first-import
  configuration. Authorized operators and administrators MAY view movements and request a manual
  refresh.
- **FR-007**: Changing the configured account MUST start a separately scoped import history and
  MUST NOT delete movements previously imported for another account.

#### Synchronization and Data Integrity

- **FR-008**: Bereius MUST attempt automatic synchronization of the configured account at least
  once every six hours.
- **FR-009**: Authorized operators and administrators MUST be able to request an immediate manual
  synchronization.
- **FR-010**: A synchronization MUST process every page advertised by Holded. It MUST NOT report
  complete success when a page is skipped, repeated ambiguously, malformed, or unavailable.
- **FR-011**: Each movement MUST be uniquely identified by the combination of its Holded treasury
  account and the stable movement identifier supplied by Holded.
- **FR-012**: Repeating any synchronization MUST create zero duplicate movements, including when
  manual and scheduled triggers overlap.
- **FR-013**: When Holded changes a previously imported movement that is returned inside the active
  synchronization window, Bereius MUST update the existing record's retained fields rather than
  create another record.
- **FR-014**: A stored movement MUST contain only the provider movement identifier, treasury
  account, booking date, optional value date, one optional narrative, amount, currency, status, and
  derived money direction needed by this feature. For the verified contract, the narrative is the
  logical concept and reference projection and the counterparty projection is empty; separate
  concept, reference, and counterparty columns are not required.
- **FR-015**: Bereius MUST NOT persist or expose the complete Holded response or unneeded provider
  fields.
- **FR-016**: Concurrent triggers for the same account MUST share, defer to, or safely serialize one
  effective synchronization so they cannot race to duplicate or regress data.
- **FR-017**: A partial failure MUST NOT advance the safe synchronization progress point beyond the
  last movement processed successfully, and a retry MUST be able to re-read overlapping data
  idempotently.
- **FR-018**: A failed synchronization MUST NOT delete or hide data from earlier successful runs and
  MUST NOT block unrelated Bereius functions.
- **FR-019**: Valid movements and valid pages processed before a later item or page failure MAY be
  retained, but the run MUST be marked partial and the unresolved remainder MUST remain retryable.

#### Validation and Classification

- **FR-020**: Every valid movement MUST be classified as exactly one of `income` or `expense`,
  representing money direction only.
- **FR-021**: Under the verified Holded contract, the signed effective amount MUST be the sole
  authoritative source of movement direction. A future direction field MUST NOT be consumed until
  renewed anonymized evidence defines its values and precedence.
- **FR-022**: Bereius MUST classify a positive effective amount as income and a negative effective
  amount as expense.
- **FR-023**: Classification MUST NOT use words from the concept, reference, counterparty, or any
  other descriptive text.
- **FR-024**: Classification MUST NOT create accounting or spending categories such as utilities,
  payroll, or bookings.
- **FR-025**: A movement is valid for totals and reconciliation only when it has a stable provider
  identifier, account association, valid date, non-zero signed amount, and a supported currency.
  The initial provider adapter supports only the observed `EUR` representation with two fractional
  digits; any other currency creates an invalid-currency incident until renewed evidence expands
  the contract.
- **FR-026**: Zero amounts, invalid currencies, and movements failing those validity conditions MUST
  be excluded from totals and reconciliation and MUST create a visible synchronization incident
  without corrupting valid movements in the same run.
- **FR-027**: Optional value date, concept, reference, counterparty, or status omissions MUST NOT by
  themselves invalidate an otherwise valid movement; the interface MUST show a neutral empty value.
- **FR-028**: Synchronization incidents MUST retain only sanitized operational context needed to
  locate the run position and understand the reason. They MUST NOT retain full provider items,
  counterparty names, or bank references.

#### Movement View

- **FR-029**: Bereius MUST provide a private, non-indexable bank-movements view available only to
  authorized operators and administrators.
- **FR-030**: Each displayed movement MUST show date, concept, counterparty, account, amount,
  currency, status, and textual income/expense classification; value date and reference MAY be
  available as secondary details.
- **FR-031**: The initial ordering MUST be movement date descending, with deterministic ordering
  between movements sharing a date.
- **FR-032**: Users MUST be able to filter by all directions, income only, or expense only; by date
  interval; account; currency; and case-insensitive text across concept, reference, and
  counterparty.
- **FR-033**: Income totals and expense totals MUST be calculated separately from all valid
  movements matching the active filter, not merely the currently visible page.
- **FR-034**: Totals MUST remain separate by currency. Income totals MUST sum incoming values and
  expense totals MUST show the summed outgoing magnitude; mixed currencies MUST never be converted
  or combined.
- **FR-035**: Income and expense MUST differ through visible text and accessible semantics in
  addition to any color or styling.
- **FR-036**: The view MUST show distinct loading, empty, active-synchronization, partial-result,
  and error states. Partial and error states MUST preserve access to earlier movements.
- **FR-037**: The view MUST show live manual-refresh progress when available, the latest attempt's
  result and time, the latest successful synchronization time, sanitized incidents, and whether a
  retry is available.

#### Booking Reconciliation

- **FR-038**: Only imported movements classified as income and valid for totals and reconciliation
  MAY participate as booking reconciliation candidates.
- **FR-039**: A movement classified as expense MUST never produce or support a reconciliation
  proposal.
- **FR-040**: Candidate matching MUST preserve the existing two mandatory conditions: the transfer
  reference contains the estimate identifier and the movement amount exactly equals the expected
  booking total to the smallest currency unit.
- **FR-041**: Proposals MUST remain unapplied until an authorized operator manually confirms or
  dismisses them, preserving the existing audit trail.
- **FR-042**: This feature MUST NOT add new automatic matching rules, combine multiple movements to
  satisfy one amount, or automatically confirm a booking.

#### Booking Candidate Selection and Reserve Invoice

- **FR-049**: Only while a booking is `AWAITING_PAYMENT`, its detail MUST list unlinked valid EUR
  income dated on or after the estimate creation date and within an inclusive ±5% of the agreed
  advance-plus-deposit total. Expenses, used movements, other currencies, movements predating the
  estimate, and dismissed or invalidated booking/movement pairs MUST be excluded.
- **FR-050**: Candidate concept text MUST NOT affect eligibility. Presence of the literal estimate
  reference MAY rank a candidate first; the remaining deterministic ranking MUST prefer the
  smallest absolute difference, newest booking date, and stable provider identity.
- **FR-051**: Explicit candidate confirmation MUST revalidate booking state, movement eligibility,
  inclusive tolerance, and exclusive movement use inside the write transaction. It MUST store the
  movement's actual amount, bank date, narrative, and linkage on the `Payment`.
- **FR-052**: Strict proposal confirmation and explicit candidate confirmation MUST atomically
  create one linked payment, transition and audit the booking, invalidate sibling proposals, create
  one reserve-invoice issuance record, and enqueue one idempotent issuance job. Manual payment
  recording MUST retain exact-amount validation and MUST NOT enqueue a reserve invoice.
- **FR-053**: The reserve invoice MUST use the booking's agreed advance and deposit, not a tolerated
  difference in the received bank amount. It MUST contain exactly two lines: the advance using its
  configured service/account with 10% VAT, and the deposit using its configured service/account as
  non-subject to VAT.
- **FR-054**: The reserve invoice issue date and due date MUST both use the payment-linkage
  timestamp, not the bank movement's calendar date.
- **FR-055**: A newly created reserve invoice MUST use Holded invoice numbering series `F`, be
  approved, and be sent with the fiscal customer email as primary recipient and every currently
  eligible principal-scoped delegate as CC. The exact recipients MUST be frozen before sending.
- **FR-056**: Bereius MUST persist issuance separately from delivery and show safe localized
  processing, sent, blocked, creation-unknown, and delivery-unknown states on the booking detail.
  Internal provider messages and recipient addresses MUST NOT appear in those states.
- **FR-057**: A pre-existing reserve invoice MAY be reused only when its fiscal contact, issue and
  due dates, total, two lines, configured accounts, unit quantities, economic amounts, and tax
  treatment exactly match the expected invoice after normalizing Holded's document-level
  tax-inclusive mode and empty non-subject tax list. A returned service identifier MUST match its
  configured service; when Holded omits it, the exact configured account remains mandatory. A
  missing or incompatible existing invoice MUST block automatic issuance rather than being
  replaced or duplicated.
- **FR-058**: An explicit provider refusal before creation or delivery MAY use bounded outbox retry.
  A timeout, HTTP 408 or 5xx response, transport interruption, malformed success response,
  abandoned in-flight operation, or other uncertain creation/delivery outcome MUST be parked as
  `UNKNOWN` and MUST NOT repeat that provider write automatically. A known provider document
  identifier MUST be persisted even when its optional display number cannot be read.
- **FR-059**: Concurrent or repeated workers MUST result in at most one reserve-invoice issuance,
  one local reserve-invoice document, and one accepted delivery per booking.

#### Security and Operations

- **FR-043**: Account configuration, filters, manual triggers, provider data, and pagination data
  MUST be validated at their server-side trust boundaries.
- **FR-044**: Logs MUST NOT contain Holded credentials, complete responses, counterparty names,
  bank references, or other unnecessary personal data.
- **FR-045**: Operational events and metrics MUST use non-personal data such as run identifiers,
  account-safe identifiers, outcome, duration, page and item counts, insert/update/incident counts,
  and error categories.
- **FR-046**: Provider failures shown to users MUST be sanitized while remaining specific enough to
  distinguish retryable outage, partial import, invalid configuration, and malformed provider data.

#### Data Lifecycle and Health

- **FR-047**: After a run commits the terminal provider page and proves complete pagination, Bereius
  MUST advance a monotonic synchronization floor to 90 calendar days before the cleanup date and
  prune older unmatched movements that have no payment and no pending or confirmed proposal.
  Dismissed or invalidated proposals for those movements MUST be removed first. An incomplete
  partial or failed run MUST NOT advance the floor. Payment-linked and pending or confirmed records
  MUST remain protected by their booking retention lifecycle, and terminal run/incident history
  MUST be pruned after 90 days.
- **FR-048**: A configured banking integration MUST be reported as degraded in the authorized view
  and structured operational signals when its latest run is `RETRYING`, `PARTIAL`, or `FAILED`, or
  when it has no successful run or its latest success is more than six hours old after no run remains
  active. That degradation MUST NOT make the application health endpoint fail while the process and
  PostgreSQL remain healthy.

### Planning Evidence Gate

Planning MUST validate the real response schema and pagination behavior of the read-only Holded
Treasury endpoint supplied for this feature:
`/api/v2/treasury/accounts/{id}/bank-movements`.

The evidence MUST come from an anonymized response for a real accessible treasury account and MUST
confirm, rather than infer:

- the response envelope and item location;
- pagination request inputs, continuation data, termination condition, and behavior on empty or
  repeated pages, plus whether provider ordering is defined or indeterminate and whether any design
  decision relies on it;
- the exact stable movement identifier and account association;
- date and optional value-date representations;
- amount representation, sign behavior, currency representation, and the presence or absence of a
  credit/debit indicator;
- the available concept, reference, counterparty, and status representations; and
- any malformed-response, authorization, rate-limit, and transient-error shapes that can be
  observed safely. When such bodies are not evidenced, they MUST remain opaque and recovery MUST be
  based only on transport failure, HTTP status class, response bounds, and success-schema parsing.

No successful-response field name, provider enum value, pagination mechanism, or checkpoint mapping
may be finalized in the plan, data model, contracts, fixtures, or tasks unless that evidence
confirms it. Generic transport/HTTP failure categories MAY be finalized without provider-body
evidence only when the implementation does not parse, retain, log, or expose the body. The evidence
MUST redact credentials, real account identifiers, counterparty names, references, and other
personal data; the unredacted response MUST NOT be committed, logged, or retained unnecessarily.

### Key Entities

- **Treasury Account Configuration**: The single active Holded treasury account selected by an
  administrator, its initial import start date, and its synchronization state. Historical account
  scopes remain distinct when configuration changes.
- **Bank Movement**: The minimal local representation of one Holded movement, uniquely identified
  within an account, with dates, display details, monetary value, provider status, derived direction,
  and update timestamps.
- **Synchronization Run**: One scheduled or manual attempt, including trigger type, lifecycle,
  non-personal progress counters, safe progress point, timestamps, and complete, partial, or failed
  outcome.
- **Synchronization Incident**: A sanitized reason why a provider item, page, or run could not be
  processed completely, linked to its run without storing sensitive provider content.
- **Reconciliation Proposal**: The existing operator-reviewed relationship between an eligible
  income movement and a booking, retaining current matching and audit behavior.
- **Document Issuance**: The persisted reserve-invoice creation/approval state, separate from its
  delivery state so an uncertain provider write cannot be retried blindly.
- **Document Delivery**: The immutable fiscal-primary and delegate-copy recipients plus the
  reserve invoice's send outcome.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of valid imported movements are classified as income or expense, and 0% are left
  without a direction.
- **SC-002**: Repeating the same synchronization, including overlapping triggers, produces zero
  duplicate records for the same account and stable provider identifier.
- **SC-003**: A corrected provider movement updates the existing local record in every acceptance
  test and creates no additional record.
- **SC-004**: For every verified multi-page response, the number of valid imported movements plus
  visible invalid-item incidents equals the number of provider items across all pages.
- **SC-005**: Under normal provider availability, a new movement appears within six hours through
  automatic synchronization or within two minutes after an accepted manual refresh request.
- **SC-006**: In a repeatable timed usability scenario starting on the movement page, an authorized
  user can locate a named synthetic movement by direction, date, account, currency, or text in
  under one minute.
- **SC-007**: For every filter acceptance dataset, displayed income and expense totals exactly match
  the filtered valid movements and remain separated by currency.
- **SC-008**: Every tested interruption can be retried to completion with zero valid movements lost,
  zero duplicates, and no safe progress point beyond the last successfully processed movement.
- **SC-009**: During a simulated Holded outage, 100% of previously imported movements remain
  accessible, an unrelated booking-management action remains usable, the authorized banking view
  reports degradation, and the application health endpoint remains successful.
- **SC-010**: Across reconciliation acceptance tests, eligible matching income movements can create
  proposals while expenses and invalid movements create zero proposals.
- **SC-011**: Candidate tests include both inclusive 5% boundaries and their nearest out-of-range
  values; only the boundary values remain confirmable, regardless of concept text.
- **SC-012**: Across repeated, concurrent, interrupted, compatible-existing, and
  incompatible-existing issuance tests, each booking has at most one reserve invoice and one
  accepted send, while every uncertain provider write causes zero automatic repeats.

## Assumptions

- Bereius already has authenticated administrator and operator roles; this feature changes neither
  registration nor authentication.
- Bereius already manages one Holded credential with permission to read the selected treasury
  account, and administrators arrange any provider-side permission outside this feature.
- One treasury account is active for synchronization at a time. Previously imported account scopes
  remain available for historical filtering after the active account changes.
- The initial import start date applies whenever the selected account has no safe synchronization
  history; the 90-day default is calculated at the time that first import is initiated.
- The initial provider adapter recognizes only `EUR` with two fractional digits because that is the
  only evidenced Holded movement currency. Persistence and grouped UI totals retain an ISO-shaped
  currency field so a later evidence-backed expansion does not require a schema redesign. Monetary
  comparison and totals use exact decimal values, not binary rounding.
- Expense totals are presented as positive outgoing magnitudes under an explicit expense label;
  row-level classification and accessible text carry the direction.
- The first clean scan may use an administrator-selected historical start date. Once it completes,
  the 90-day synchronization floor advances monotonically so pruned unmatched movements are not
  re-imported; retained payment/proposal evidence outside that floor is no longer polled for
  provider corrections.
- Existing booking retention, backup, and authorized personal-data access policies apply to
  payment-linked movement fields and reconciliation audit records.
- The production scheduler can invoke work at least every six hours; its concrete mechanism is a
  planning decision.

## Non-Goals *(mandatory)*

- Creating, modifying, or deleting bank movements in Holded.
- Initiating transfers, direct debits, or payments.
- Replacing Holded as the accounting system.
- Categorizing expenses or income by ledger account, supplies, payroll, bookings, or any other
  accounting purpose.
- Importing from Enable Banking and Holded at the same time.
- Adding new matching heuristics, split-payment aggregation, automatic confirmation, or other new
  reconciliation rules.
- Converting currencies or presenting one cross-currency total.
- Importing non-`EUR` movements before renewed provider evidence expands the accepted contract.
- Retaining full Holded payloads for debugging or analytics.

## Security & Privacy Implications *(mandatory)*

- **Authentication/Authorization**: Every page and action is authenticated. Server-side role checks
  restrict account changes to administrators and movement access/manual refresh to authorized
  operators and administrators; client-supplied roles or account scope are never trusted.
- **Account lifecycle**: N/A; this feature creates no users and changes no sign-in behavior.
- **Authentication provider verification**: N/A; the existing application authentication boundary
  remains unchanged, while integration tests must verify the new role restrictions.
- **Data sensitivity**: Bank movements can contain third-party personal and financial data. Access
  is least-privilege, storage is limited to the minimal movement fields defined above, raw responses
  are discarded after processing, and existing retention/export/deletion policy remains
  authoritative.
- **Input validation**: Account identifiers, first-import dates, filters, trigger requests,
  pagination controls, monetary values, currencies, dates, identifiers, status, and direction data
  require server-side validation before use or persistence.
- **Log hygiene**: Credentials, authorization headers, raw payloads, counterparty names, references,
  concepts when they can identify a person, and provider error bodies are excluded or redacted.
- **Public exposure**: No page or action is intentionally public. The authenticated page is private
  and non-indexable, excluded from sitemaps, and any non-HTML route emits an equivalent crawler
  exclusion header; crawler controls do not replace authorization.

## Threats & Abuse Cases *(mandatory for public endpoints or privileged actions)*

- **Abuse scenarios**: An operator attempts to change the configured account; a user enumerates
  movements or other account identifiers; repeated manual triggers exhaust provider limits; replayed
  or concurrent jobs duplicate data; malicious provider data injects content; malformed pagination
  causes omission or an infinite loop; sensitive values leak through logs, metrics, incidents, or
  error messages.
- **Controls**: Enforce server-side role and account-scope checks, output escaping, request and
  response validation, idempotent account-scoped identity, single effective synchronization per
  account, bounded work with explicit partial continuation rather than silent truncation, manual-
  trigger abuse controls, sanitized errors, and non-personal observability.
- **Residual risk**: Holded users with access to the accounting account can change data or revoke
  read access outside Bereius. Provider delays and outages can make local data temporarily stale;
  visible timestamps, failure state, retained records, and retry support make that risk explicit.

## Operational Impact

- **Deployment changes**: Periodic six-hour execution and resumable synchronization are required,
  using the existing Holded credential and no new externally reachable service or secret.
- **Data & migrations**: New persistent configuration, movement, run, incident, and progress data
  require a forward-only migration. Deployment and rollback procedures must preserve imported data
  and existing booking reconciliation records.
- **Recovery**: Before migration, take the normal database backup and verify the documented restore
  path. Application rollback must leave newly stored records intact for a corrected forward release;
  provider outages require retry, never deletion or destructive reset.
- **Observability**: Record structured, non-personal synchronization lifecycle events and metrics
  for duration, result, freshness, pages, processed/inserted/updated/invalid counts, retries, and
  categorized failures. The authorized banking view and operational signals report stale or failed
  synchronization as integration degradation. The existing health endpoint remains an application
  and PostgreSQL readiness probe and returns success during a Holded-only outage.