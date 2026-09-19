// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseHoldedBankMovement } from "@/modules/banking/services/movements";
import { createHoldedTreasuryFixtureScope } from "../helpers/holded-treasury";

describe("Holded bank movement parser", () => {
  it.each([
    ["125.50", BigInt(12_550), "INCOME"],
    ["0.01", BigInt(1), "INCOME"],
    ["-125.50", BigInt(-12_550), "EXPENSE"],
    ["-0.01", BigInt(-1), "EXPENSE"],
  ] as const)(
    "parses exact two-decimal EUR amount %s without floating point",
    (amount, amountMinor, direction) => {
      const fixtures = createHoldedTreasuryFixtureScope();
      const account = fixtures.account();
      const payload = fixtures.movement(account.id, { amount });

      expect(parseHoldedBankMovement(payload, account.id)).toEqual({
        ok: true,
        movement: {
          holdedMovementId: payload.id,
          bookingDate: new Date("2026-09-16T00:00:00.000Z"),
          valueDate: new Date("2026-09-16T00:00:00.000Z"),
          narrative: payload.description,
          amountMinor,
          currency: "EUR",
          providerStatus: "pending",
          direction,
        },
      });
    },
  );

  it("retains the leading bank dates without timezone conversion", () => {
    const fixtures = createHoldedTreasuryFixtureScope();
    const account = fixtures.account();
    const payload = fixtures.movement(account.id, {
      booking_date: "2026-01-01T00:15:00+14:00",
      value_date: "2026-12-31T23:45:00-12:00",
    });

    const parsed = parseHoldedBankMovement(payload, account.id);

    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) {
      expect(parsed.movement.bookingDate.toISOString()).toBe(
        "2026-01-01T00:00:00.000Z",
      );
      expect(parsed.movement.valueDate?.toISOString()).toBe(
        "2026-12-31T00:00:00.000Z",
      );
    }
  });

  it.each([
    [{ value_date: undefined }, { valueDate: null }],
    [{ value_date: null }, { valueDate: null }],
    [{ description: undefined }, { narrative: null }],
    [{ description: null }, { narrative: null }],
    [{ description: "   " }, { narrative: null }],
    [{ description: "  Synthetic narrative  " }, { narrative: "Synthetic narrative" }],
    [{ status: undefined }, { providerStatus: null }],
    [{ status: null }, { providerStatus: null }],
    [{ status: "  reconciled  " }, { providerStatus: "reconciled" }],
  ])("normalizes optional provider fields", (overrides, expected) => {
    const fixtures = createHoldedTreasuryFixtureScope();
    const account = fixtures.account();
    const payload = fixtures.movement(account.id, overrides);

    expect(parseHoldedBankMovement(payload, account.id)).toMatchObject({
      ok: true,
      movement: expected,
    });
  });

  it.each([
    ["missing", undefined],
    ["short", "abc"],
    ["non-hex", "zzzzzzzzzzzzzzzzzzzzzzzz"],
  ])("rejects a %s movement identifier", (_label, id) => {
    const fixtures = createHoldedTreasuryFixtureScope();
    const account = fixtures.account();
    const payload = fixtures.movement(account.id);
    if (id === undefined) Reflect.deleteProperty(payload, "id");
    else payload.id = id;

    expect(parseHoldedBankMovement(payload, account.id)).toEqual({
      ok: false,
      incident: { code: "INVALID_MOVEMENT_ID", holdedMovementId: null },
    });
  });

  it.each([
    ["malformed", "not-an-account-id"],
    ["different", "ffffffffffffffffffffffff"],
  ])("rejects a %s movement account", (_label, bankingAccountId) => {
    const fixtures = createHoldedTreasuryFixtureScope();
    const account = fixtures.account();
    const payload = fixtures.movement(account.id, {
      banking_account_id: bankingAccountId,
    });

    expect(parseHoldedBankMovement(payload, account.id)).toEqual({
      ok: false,
      incident: { code: "ACCOUNT_MISMATCH", holdedMovementId: payload.id },
    });
  });

  it.each([
    "2026-09-16",
    "2026-09-16T10:00:00",
    "2026-02-30T10:00:00Z",
    "not-a-date",
  ])("rejects invalid booking date %s", (bookingDate) => {
    const fixtures = createHoldedTreasuryFixtureScope();
    const account = fixtures.account();
    const payload = fixtures.movement(account.id, { booking_date: bookingDate });

    expect(parseHoldedBankMovement(payload, account.id)).toEqual({
      ok: false,
      incident: { code: "INVALID_BOOKING_DATE", holdedMovementId: payload.id },
    });
  });

  it.each([
    "2026-09-16",
    "2026-09-16T10:00:00",
    "2026-02-30T10:00:00Z",
    "not-a-date",
  ])("rejects invalid value date %s", (valueDate) => {
    const fixtures = createHoldedTreasuryFixtureScope();
    const account = fixtures.account();
    const payload = fixtures.movement(account.id, { value_date: valueDate });

    expect(parseHoldedBankMovement(payload, account.id)).toEqual({
      ok: false,
      incident: { code: "INVALID_VALUE_DATE", holdedMovementId: payload.id },
    });
  });

  it.each(["125", "125.5", "125.500", "+125.50", "1,25", "NaN", ""])(
    "rejects invalid amount %s",
    (amount) => {
      const fixtures = createHoldedTreasuryFixtureScope();
      const account = fixtures.account();
      const payload = fixtures.movement(account.id, { amount });

      expect(parseHoldedBankMovement(payload, account.id)).toEqual({
        ok: false,
        incident: { code: "INVALID_AMOUNT", holdedMovementId: payload.id },
      });
    },
  );

  it.each(["0.00", "-0.00"])("rejects zero amount %s", (amount) => {
    const fixtures = createHoldedTreasuryFixtureScope();
    const account = fixtures.account();
    const payload = fixtures.movement(account.id, { amount });

    expect(parseHoldedBankMovement(payload, account.id)).toEqual({
      ok: false,
      incident: { code: "ZERO_AMOUNT", holdedMovementId: payload.id },
    });
  });

  it.each(["USD", "eur", "EURO", ""])("rejects unverified currency %s", (currency) => {
    const fixtures = createHoldedTreasuryFixtureScope();
    const account = fixtures.account();
    const payload = fixtures.movement(account.id, { currency });

    expect(parseHoldedBankMovement(payload, account.id)).toEqual({
      ok: false,
      incident: { code: "INVALID_CURRENCY", holdedMovementId: payload.id },
    });
  });

  it("rejects a narrative over the retained limit", () => {
    const fixtures = createHoldedTreasuryFixtureScope();
    const account = fixtures.account();
    const payload = fixtures.movement(account.id, { description: "x".repeat(2_001) });

    expect(parseHoldedBankMovement(payload, account.id)).toEqual({
      ok: false,
      incident: { code: "DESCRIPTION_TOO_LONG", holdedMovementId: payload.id },
    });
  });

  it("rejects an overlong provider status without retaining it", () => {
    const fixtures = createHoldedTreasuryFixtureScope();
    const account = fixtures.account();
    const payload = fixtures.movement(account.id, { status: "x".repeat(65) });

    expect(parseHoldedBankMovement(payload, account.id)).toEqual({
      ok: false,
      incident: { code: "MALFORMED_PAGE", holdedMovementId: payload.id },
    });
  });

  it.each([
    ["incoming refund expense debit", "125.50", "INCOME"],
    ["salary income credit transfer", "-125.50", "EXPENSE"],
  ] as const)(
    "classifies direction only from the sign despite text %s",
    (description, amount, direction) => {
      const fixtures = createHoldedTreasuryFixtureScope();
      const account = fixtures.account();
      const payload = fixtures.movement(account.id, { description, amount });

      expect(parseHoldedBankMovement(payload, account.id)).toMatchObject({
        ok: true,
        movement: { direction },
      });
    },
  );
});