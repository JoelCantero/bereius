import { describe, expect, it } from "vitest";

import { quoteNotes, stayDescription, stayPhrase } from "@/modules/booking/wording";

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe("booking wording", () => {
  it("titles a document the way every existing one is titled", () => {
    expect(stayDescription(day("2027-11-19"), day("2027-11-21"), 40, "DC")).toBe(
      "19/11/27 - 21/11/27 - 40 persones DC",
    );
  });

  it("pads single-digit days and months", () => {
    expect(stayDescription(day("2027-01-05"), day("2027-01-07"), 30, "PC")).toBe(
      "05/01/27 - 07/01/27 - 30 persones PC",
    );
  });

  it("names the weekdays and months in Catalan", () => {
    expect(stayPhrase(day("2027-11-19"), day("2027-11-21"), 40, 2)).toBe(
      "del divendres, 19 de novembre al diumenge, 21 de novembre del 2027. " +
        "40 persones i 2 nits. Entrada i sortida a les 16 h.",
    );
  });

  it("elides the preposition before a vowel", () => {
    expect(stayPhrase(day("2026-07-26"), day("2026-08-02"), 85, 7)).toContain(
      "al diumenge, 2 d'agost del 2026",
    );
  });

  it("keeps the singular for a one-night stay", () => {
    expect(stayPhrase(day("2027-03-05"), day("2027-03-06"), 30, 1)).toContain(
      "30 persones i 1 nit.",
    );
  });

  it("states the amounts a booking must pay to be confirmed", () => {
    const notes = quoteNotes({
      startDate: day("2027-11-19"),
      endDate: day("2027-11-21"),
      headcount: 40,
      nights: 2,
      advanceCents: 31_200,
      depositCents: 20_000,
      amountToConfirmCents: 51_200,
    });

    expect(notes).toContain("Reserva bestreta: 312 €.");
    expect(notes).toContain("Dipòsit: 200 €.");
    expect(notes).toContain("Total per a confirmar la reserva: 512 €");
  });

  it("shows cents only when there are any", () => {
    const notes = quoteNotes({
      startDate: day("2027-11-19"),
      endDate: day("2027-11-21"),
      headcount: 40,
      nights: 2,
      advanceCents: 31_255,
      depositCents: 20_000,
      amountToConfirmCents: 51_255,
    });

    expect(notes).toContain("Reserva bestreta: 312,55 €.");
  });
});
