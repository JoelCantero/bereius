// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  DocumentDeliveryError,
  resolveDocumentRecipients,
} from "@/modules/booking/services/document-delivery";

describe("estimate recipients", () => {
  it("normalizes the fiscal recipient and sorts unique delegate copies", () => {
    expect(
      resolveDocumentRecipients(" Fiscal@Example.test ", [
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
      resolveDocumentRecipients("fiscal@example.test", [" FISCAL@EXAMPLE.TEST "]),
    ).toEqual({ emails: ["fiscal@example.test"], cc: [] });
  });

  it("falls back to the fiscal address when there are no active delegates", () => {
    expect(resolveDocumentRecipients("fiscal@example.test", [])).toEqual({
      emails: ["fiscal@example.test"],
      cc: [],
    });
  });

  it.each(["", "   ", "not-an-email"])(
    "refuses an unusable fiscal address %o",
    (email) => {
      expect(() => resolveDocumentRecipients(email, [])).toThrowError(
        expect.objectContaining<Partial<DocumentDeliveryError>>({
          code: "missing_fiscal_email",
        }),
      );
    },
  );

  it("refuses an invalid managed delegate instead of silently omitting it", () => {
    expect(() =>
      resolveDocumentRecipients("fiscal@example.test", ["not-an-email"]),
    ).toThrowError(
      expect.objectContaining<Partial<DocumentDeliveryError>>({
        code: "invalid_delegate_email",
      }),
    );
  });
});