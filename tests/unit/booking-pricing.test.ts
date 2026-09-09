// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  BILLABLE_HEADCOUNT_FLOOR,
  BookingPricingError,
  billableHeadcount,
  countNights,
  quoteStay,
  resolveHeadcountBand,
  resolveServiceSku,
  SECURITY_DEPOSIT_CENTS,
} from "@/modules/booking/services/pricing";

function utcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

describe("booking pricing", () => {
  describe("night counting", () => {
    it.each([
      ["2027-06-01", "2027-06-03", 2],
      ["2027-06-01", "2027-06-02", 1],
      ["2027-11-19", "2027-11-21", 2],
      ["2027-12-28", "2028-01-04", 7],
      ["2028-02-27", "2028-03-01", 3],
    ])("counts %s to %s as %i nights", (start, end, expected) => {
      expect(countNights(utcDate(start), utcDate(end))).toBe(expected);
    });

    // The retired workflow subtracted milliseconds and divided by 86 400 000,
    // which yields 2.0417 across a spring clock change and put fractional
    // quantities on the estimate.
    it.each([
      ["2027-03-27", "2027-03-29", 2],
      ["2027-10-30", "2027-11-01", 2],
      ["2027-03-26", "2027-03-30", 4],
    ])(
      "counts %s to %s as a whole number across a clock change",
      (start, end, expected) => {
        const nights = countNights(utcDate(start), utcDate(end));
        expect(nights).toBe(expected);
        expect(Number.isInteger(nights)).toBe(true);
      },
    );

    it.each([
      ["2027-06-03", "2027-06-01"],
      ["2027-06-01", "2027-06-01"],
    ])("refuses the impossible stay %s to %s", (start, end) => {
      expect(() => countNights(utcDate(start), utcDate(end))).toThrow(
        BookingPricingError,
      );
    });
  });

  describe("billable headcount", () => {
    // The retired workflow multiplied by the exact headcount, under-billing
    // every group below the floor.
    it.each([
      [1, 30],
      [22, 30],
      [29, 30],
      [30, 30],
      [31, 31],
      [120, 120],
    ])("bills a group of %i as %i places", (headcount, expected) => {
      expect(billableHeadcount(headcount)).toBe(expected);
    });

    it.each([0, -5, 12.5, Number.NaN])("refuses a headcount of %j", (headcount) => {
      expect(() => billableHeadcount(headcount)).toThrow(BookingPricingError);
    });
  });

  describe("rate bands", () => {
    it.each([
      [1, "30"],
      [30, "30"],
      [39, "30"],
      [40, "40"],
      [59, "40"],
      [60, "60"],
      [79, "60"],
      [80, "80"],
      [200, "80"],
    ] as const)("puts %i in band %s", (headcount, band) => {
      expect(resolveHeadcountBand(headcount)).toBe(band);
    });

    it.each([
      ["SELF_CATERING", 40, "dc40"],
      ["SELF_CATERING", 22, "dc30"],
      ["FULL_BOARD", 45, "pc40"],
      ["FULL_BOARD", 80, "pc80"],
    ] as const)("resolves %s with %i people to %s", (boardType, headcount, sku) => {
      expect(resolveServiceSku(boardType, headcount)).toBe(sku);
    });
  });

  describe("quoting a stay", () => {
    it("bills the floor for a small group", () => {
      const quote = quoteStay({
        boardType: "SELF_CATERING",
        headcount: 22,
        startDate: utcDate("2027-06-01"),
        endDate: utcDate("2027-06-03"),
        unitPriceCents: 1_800,
      });

      // 2 nights x 30 places, not 2 x 22.
      expect(quote.units).toBe(60);
      expect(quote.billableHeadcount).toBe(BILLABLE_HEADCOUNT_FLOOR);
      expect(quote.stayTotalCents).toBe(108_000);
      expect(quote.advanceCents).toBe(32_400);
      expect(quote.depositCents).toBe(SECURITY_DEPOSIT_CENTS);
      expect(quote.amountToConfirmCents).toBe(52_400);
    });

    it("prices the reference full-board stay", () => {
      const quote = quoteStay({
        boardType: "FULL_BOARD",
        headcount: 40,
        startDate: utcDate("2027-11-19"),
        endDate: utcDate("2027-11-21"),
        unitPriceCents: 3_200,
      });

      expect(quote).toMatchObject({
        nights: 2,
        units: 80,
        serviceSku: "pc40",
        stayTotalCents: 256_000,
        advanceCents: 76_800,
        amountToConfirmCents: 96_800,
      });
    });

    it.each([
      [1_800, 30],
      [1_600, 40],
      [1_500, 60],
      [1_300, 80],
      [3_400, 33],
      [2_900, 101],
      [1_733, 77],
      [1, 31],
      [3_333, 47],
    ])(
      "keeps every amount a whole number of cents at %i cents for %i people",
      (unitPriceCents, headcount) => {
        const quote = quoteStay({
          boardType: "SELF_CATERING",
          headcount,
          startDate: utcDate("2027-06-01"),
          endDate: utcDate("2027-06-03"),
          unitPriceCents,
        });

        for (const amount of [
          quote.stayTotalCents,
          quote.advanceCents,
          quote.advanceNetCents,
          quote.depositCents,
          quote.amountToConfirmCents,
        ]) {
          expect(Number.isSafeInteger(amount)).toBe(true);
        }
      },
    );

    it("derives the net advance without leaving a repeating decimal", () => {
      // The retired workflow computed 21 600 / 1.10 in floating point and sent
      // 19636.363636363636 to Holded.
      const quote = quoteStay({
        boardType: "SELF_CATERING",
        headcount: 30,
        startDate: utcDate("2027-06-01"),
        endDate: utcDate("2027-06-02"),
        unitPriceCents: 2_400,
      });

      expect(quote.advanceCents).toBe(21_600);
      expect(quote.advanceNetCents).toBe(19_636);
      expect(String(quote.advanceNetCents)).not.toContain(".");
    });

    it("refuses a unit price that is not whole cents", () => {
      expect(() =>
        quoteStay({
          boardType: "SELF_CATERING",
          headcount: 40,
          startDate: utcDate("2027-06-01"),
          endDate: utcDate("2027-06-03"),
          unitPriceCents: 18.5,
        }),
      ).toThrow(BookingPricingError);
    });
  });
});
