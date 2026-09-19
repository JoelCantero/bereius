import { useTranslations } from "next-intl";

import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default function BankMovementsLoading() {
  const t = useTranslations("BankMovements");
  const headings = [
    "valueDate",
    "concept",
    "amount",
    "status",
    "direction",
  ] as const;

  return (
    <div role="status" aria-live="polite" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">{t("loading")}</span>
      <Skeleton className="h-8 w-64" aria-hidden="true" />
      <Skeleton className="h-20 w-full" aria-hidden="true" />
      <Table className="min-w-[44rem] table-fixed">
        <TableCaption>{t("table.caption")}</TableCaption>
        <TableHeader>
          <TableRow>
            {headings.map((heading) => (
              <TableHead key={heading}>{t(`table.${heading}`)}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 5 }, (_, rowIndex) => (
            <TableRow key={rowIndex}>
              {headings.map((heading) => (
                <TableCell key={heading}>
                  <Skeleton className="h-5 w-full" aria-hidden="true" />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}