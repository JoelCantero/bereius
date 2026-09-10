// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createBookingSubmissionParser,
  DEFAULT_GRAVITY_FORM_FIELDS,
} from "@/modules/booking/schema";

const parser = createBookingSubmissionParser(DEFAULT_GRAVITY_FORM_FIELDS);
const parse = (entry: unknown) => parser.parse(entry);
const f = DEFAULT_GRAVITY_FORM_FIELDS;

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: "1077",
    date_created: "2026-09-07 10:00:00",
    [f.firstName]: "Joel",
    [f.lastName]: "Cantero",
    [f.organisation]: "Juventud para Cristo",
    [f.taxId]: "b12345678",
    [f.email]: "Hola@Example.test",
    [f.phone]: "+34600000000",
    [f.addressLine]: "Carrer Example 1",
    [f.city]: "Barcelona",
    [f.province]: "Barcelona",
    [f.postalCode]: "08001",
    [f.country]: "España",
    [f.headcount]: "40",
    [f.boardType]: "dc",
    [f.startDate]: "2026-11-13",
    [f.endDate]: "2026-11-15",
    ...overrides,
  };
}

describe("Gravity Forms submission parsing", () => {
  it("accepts the unpadded dates Gravity Forms actually sends", () => {
    const result = parse(entry({ [f.startDate]: "2027-7-4", [f.endDate]: "2027-7-10" }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.submission.stay.startDate.toISOString()).toBe(
      "2027-07-04T00:00:00.000Z",
    );
    expect(result.submission.stay.endDate.toISOString()).toBe("2027-07-10T00:00:00.000Z");
  });

  it("reads a padded date as the same day", () => {
    const result = parse(entry({ [f.startDate]: "2027-07-04" }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.submission.stay.startDate.toISOString()).toBe(
      "2027-07-04T00:00:00.000Z",
    );
  });

  it("keeps the day the requester picked, with no timezone drift", () => {
    const result = parse(entry());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.submission.stay.startDate.toISOString().slice(0, 10)).toBe("2026-11-13");
  });

  it.each(["2027-2-30", "2027-13-1", "2027-0-5", "not-a-date", ""])(
    "refuses %o rather than rolling it into another month",
    (value) => {
      const result = parse(entry({ [f.startDate]: value }));

      expect(result.ok).toBe(false);
    },
  );

  it("normalises the tax id and the email", () => {
    const result = parse(entry({ [f.taxId]: " b 123 45678 " }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.submission.customer.taxId).toBe("B12345678");
    expect(result.submission.customer.email).toBe("hola@example.test");
  });
});
