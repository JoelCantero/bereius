/**
 * The wording Holded documents carry. Copied from the documents the account
 * already holds, so a quote this application issues is indistinguishable from
 * the ones the retired workflow produced.
 */

const WEEKDAYS = [
  "diumenge",
  "dilluns",
  "dimarts",
  "dimecres",
  "dijous",
  "divendres",
  "dissabte",
] as const;

const MONTHS = [
  "gener",
  "febrer",
  "març",
  "abril",
  "maig",
  "juny",
  "juliol",
  "agost",
  "setembre",
  "octubre",
  "novembre",
  "desembre",
] as const;

/** Catalan elides the preposition before a vowel: d'agost, but de juliol. */
function withPreposition(month: string): string {
  return /^[aeiou]/u.test(month) ? `d'${month}` : `de ${month}`;
}

function longDate(date: Date): string {
  const weekday = WEEKDAYS[date.getUTCDay()];
  const month = MONTHS[date.getUTCMonth()];
  return `${weekday}, ${date.getUTCDate()} ${withPreposition(month)}`;
}

function shortDate(date: Date): string {
  return [
    String(date.getUTCDate()).padStart(2, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCFullYear()).slice(2),
  ].join("/");
}

const amountFormat = new Intl.NumberFormat("ca-ES", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function euros(cents: number): string {
  return `${amountFormat.format(cents / 100)} €`;
}

/** The one-line title every document in the account uses. */
export function stayDescription(
  startDate: Date,
  endDate: Date,
  headcount: number,
  board: "DC" | "PC",
): string {
  return `${shortDate(startDate)} - ${shortDate(endDate)} - ${headcount} persones ${board}`;
}

export function stayPhrase(
  startDate: Date,
  endDate: Date,
  headcount: number,
  nights: number,
): string {
  return (
    `del ${longDate(startDate)} al ${longDate(endDate)} del ${endDate.getUTCFullYear()}. ` +
    `${headcount} persones i ${nights} ${nights === 1 ? "nit" : "nits"}. ` +
    "Entrada i sortida a les 16 h."
  );
}

export function quoteNotes(input: {
  startDate: Date;
  endDate: Date;
  headcount: number;
  nights: number;
  advanceCents: number;
  depositCents: number;
  amountToConfirmCents: number;
}): string {
  return (
    `${stayPhrase(input.startDate, input.endDate, input.headcount, input.nights)} ` +
    `Reserva bestreta: ${euros(input.advanceCents)}. ` +
    `Dipòsit: ${euros(input.depositCents)}. ` +
    `Total per a confirmar la reserva: ${euros(input.amountToConfirmCents)}`
  );
}

export const DEPOSIT_LINE = {
  name: "Dipòsit",
  description: "Es retornarà un cop finalitzada l'estada i tot estigui en condicions.",
} as const;

export const ADVANCE_LINE = {
  name: "Reserva",
  description: "30% de l'import total del pressupost.",
} as const;
