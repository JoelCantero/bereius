// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  EstimateDeliveryError,
  resolveEstimateRecipients,
} from "@/modules/booking/services/estimate-delivery";

describe("estimate recipients", () => {
  it("normalizes the fiscal recipient and sorts unique delegate copies", () => {
    expect(
      resolveEstimateRecipients(" Fiscal@Example.test ", [
        "Zulu@Example.test",
        " alpha@example.test ",
        "ALPHA@example.test",
      ]),
    ).toEqual({
      emails: ["fiscal@example.test"],
      cc: ["alpha@example.test", "zulu@example.test"],
    });
  });

  it("never repeats the fiscal address in CC", () => {
    expect(
      resolveEstimateRecipients("fiscal@example.test", [" FISCAL@EXAMPLE.TEST "]),
    ).toEqual({ emails: ["fiscal@example.test"], cc: [] });
  });

  it("falls back to the fiscal address when there are no active delegates", () => {
    expect(resolveEstimateRecipients("fiscal@example.test", [])).toEqual({
      emails: ["fiscal@example.test"],
      cc: [],
    });
  });

  it.each(["", "   ", "not-an-email"])(
    "refuses an unusable fiscal address %o",
    (email) => {
      expect(() => resolveEstimateRecipients(email, [])).toThrowError(
        expect.objectContaining<Partial<EstimateDeliveryError>>({
          code: "missing_fiscal_email",
        }),
      );
    },
  );

  it("refuses an invalid managed delegate instead of silently omitting it", () => {
    expect(() =>
      resolveEstimateRecipients("fiscal@example.test", ["not-an-email"]),
    ).toThrowError(
      expect.objectContaining<Partial<EstimateDeliveryError>>({
        code: "invalid_delegate_email",
      }),
    );
  });
});