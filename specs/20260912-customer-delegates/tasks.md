---
description: "Task list for WordPress-owned customer delegates and estimate recipients"
---

# Tasks: Customer Delegates

**Input**: [spec.md](./spec.md) and [plan.md](./plan.md)

## Phase 1: Delegate Lifecycle in WordPress

- [X] T001 Keep WordPress as authority for principal/delegate relationships, status and generation.
- [X] T002 Keep delegation always enabled and enforce principal-only management, nonces, limits and rate limiting.
- [X] T003 Activate pending delegates only after a valid single-use Magic Login; revoke tokens and sessions immediately on revocation.
- [X] T004 Emit validated in-process lifecycle events after WordPress state commits.
- [X] T005 Store the managed Holded person ID and generation in delegate user meta.

## Phase 2: WordPress-Owned Holded Projection

- [X] T006 Add `includes/account-delegation-holded.php` after the existing Holded client is loaded.
- [X] T007 On acceptance, find or create an `is_person=true` contact marked `berea-wp-delegate:<principal-holded-id>:<id>:<generation>` without writing the fiscal principal.
- [X] T008 Ensure pending invitations and pending reinvitations create no Holded person.
- [X] T009 Update the verified same-generation person when an active delegate changes profile.
- [X] T010 On revocation, verify ownership, archive directly and only then clear person metadata.
- [X] T011 Restrict delegate writes to canonical fields on WordPress-owned person records and never replace the fiscal principal.
- [X] T012 Add a delegate-ID-keyed, 100-entry WP-Cron queue that recomputes current state, drains five operations per minute and retries with bounded backoff.
- [X] T013 Add a versioned backfill that requeues all active delegates for marker migration and stale people needing removal.
- [X] T014 Remove the old bridge queue, replay option, cron hook, URL/secret constants and HMAC transport.
- [X] T015 Cover pending, activation, marker migration, no-principal-write update/revocation, reinvitation, backfill, retry and access independence in the PHP contract test.

## Phase 3: Bereius Reads Holded

- [X] T016 Add `HoldedClient.listDelegateEmails(contactId)`.
- [X] T017 Page the Holded contact collection and accept only `is_person=true`, exact principal-scoped `code` and valid email values.
- [X] T018 Normalize, deduplicate and deterministically sort delegate addresses.
- [X] T019 Fail closed on failed/incomplete pagination or malformed matching managed contacts.
- [X] T020 Prepare `EstimateDelivery` only after successful Holded discovery; keep fiscal To separate from delegate CC and deduplicate across both.
- [X] T021 Preserve immutable recipients and `PREPARED`, `IN_FLIGHT`, `ACCEPTED`, `FAILED`, `UNKNOWN` delivery behavior.
- [X] T022 Apply delegate copies to estimates only and keep Holded global copy recipients disabled.
- [X] T023 Keep Gravity Forms intake and the booking model free of requester/delegate/author identity.

## Phase 4: Remove the Superseded Bereius Projection

- [X] T024 Delete the WordPress API route, client, signatures, event ingestion, reconciliation and delegate-sync services.
- [X] T025 Remove the delegate-sync scheduler handler and obsolete event/reconciliation schemas.
- [X] T026 Remove WordPress integration settings, actions, UI, translations and tests.
- [X] T027 Remove `CustomerRepresentative`, `ReceivedDelegateEvent`, `RepresentativeStatus`, the customer relation and `IntegrationProvider.WORDPRESS`.
- [X] T028 Add a forward migration that removes already-applied obsolete structures while preserving `EstimateDelivery`.
- [X] T029 Regenerate Prisma and pass the Bereius typecheck.

## Phase 5: Documentation and Validation

- [X] T030 Rewrite the feature specification, plan, task list and WordPress system documentation around the final responsibility split.
- [X] T031 Update the original project-specification amendments so they no longer authorize or describe the retired HMAC bridge.
- [X] T032 Run Prisma validation, lint, focused/full tests and production build; record unrelated failures separately.
- [X] T033 Deploy the WordPress plugin and account for host opcode caching.
- [X] T034 Verify the `bulk-archive` body with a disposable person; production returned HTTP 400 for `ids` and HTTP 204 for `contact_ids` on 2026-09-13, and the active People view no longer listed it.
- [X] T035 Run backfill and confirm the existing production delegate remains active while its existing person receives the marker for the expected fiscal principal; do not revoke it or remove the stale forward link.

## Operational Follow-up

These production operations remain pending and are not implementation-compliance tasks:

- T036 (pending): Send one controlled estimate and verify fiscal `emails`, delegate `cc`, persisted recipients and no duplicate delivery.
- T037 (pending): Restore the fiscal principal's lost `social_networks` manually in Holded; do not use another v2 full-contact PUT.

## Release Gate

Production is complete only when T032-T037 pass. A failed Holded projection never justifies changing
WordPress delegate access. An unverified bulk-archive contract blocks production revocation testing,
not invitation acceptance or read-only estimate verification.