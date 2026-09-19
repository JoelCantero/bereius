import { Fragment } from "react";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ReconciliationActions,
  type ReconciliationActionsProps,
} from "@/modules/banking/components/reconciliation-actions";
import type { BankMovementRow } from "@/modules/banking/types";

export interface MovementTableProps {
  rows: BankMovementRow[];
  locale: "en" | "es" | "ca";
  confirmAction: ReconciliationActionsProps["confirmAction"];
  dismissAction: ReconciliationActionsProps["dismissAction"];
}

const GREEN_BADGE =
  "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200";
const RED_BADGE =
  "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200";

function formatBankDate(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00.000Z`));
}

export function formatMinorUnits(
  value: string,
  currency: string,
  locale: string,
  signDisplay: "always" | "never" = "always",
) {
  const amount = BigInt(value);
  const negative = amount < BigInt(0);
  const absolute = negative ? -amount : amount;
  const whole = absolute / BigInt(100);
  const fraction = (absolute % BigInt(100)).toString().padStart(2, "0");
  const groupedWhole = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
  }).format(whole);
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay,
  });
  const decimal =
    formatter.formatToParts(1.1).find((part) => part.type === "decimal")?.value ??
    ".";
  let insertedAmount = false;

  return formatter
    .formatToParts(negative ? -1 : 1)
    .flatMap((part) => {
      if (["integer", "group", "decimal", "fraction"].includes(part.type)) {
        if (part.type === "integer" && !insertedAmount) {
          insertedAmount = true;
          return `${groupedWhole}${decimal}${fraction}`;
        }
        return "";
      }
      return part.value;
    })
    .join("");
}

export function MovementTable({
  rows,
  locale,
  confirmAction,
  dismissAction,
}: MovementTableProps) {
  const t = useTranslations("BankMovements");
  const empty = t("emptyValue");

  return (
    <Table className="min-w-[44rem] table-fixed">
      <TableCaption>{t("table.caption")}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead className="w-32">{t("table.valueDate")}</TableHead>
          <TableHead className="w-52">{t("table.concept")}</TableHead>
          <TableHead className="w-36 text-right">{t("table.amount")}</TableHead>
          <TableHead className="w-28">{t("table.status")}</TableHead>
          <TableHead className="w-28">{t("table.direction")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <Fragment key={row.id}>
            <TableRow data-direction={row.direction}>
              <TableCell>
                {row.valueDate ? formatBankDate(row.valueDate, locale) : empty}
              </TableCell>
              <TableCell className="whitespace-normal break-words">
                {row.concept ?? empty}
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">
                {formatMinorUnits(row.amountMinor, row.currency, locale)}
              </TableCell>
              <TableCell>
                <Badge
                  className={row.status === "reconciled" ? GREEN_BADGE : RED_BADGE}
                >
                  {t(`statuses.${row.status}`)}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge
                  className={row.direction === "income" ? GREEN_BADGE : RED_BADGE}
                >
                  {t(`directions.${row.direction}`)}
                </Badge>
              </TableCell>
            </TableRow>
            {row.proposals.map((proposal) => (
              <TableRow key={proposal.id} className="hover:bg-transparent">
                <TableCell
                  colSpan={5}
                  className="bg-zinc-50/70 py-3 dark:bg-zinc-900/30"
                >
                  <ReconciliationActions
                    proposal={proposal}
                    confirmAction={confirmAction}
                    dismissAction={dismissAction}
                  />
                </TableCell>
              </TableRow>
            ))}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  );
}