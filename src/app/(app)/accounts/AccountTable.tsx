import Link from "next/link";
import { Building2 } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export type AccountRow = {
  id: string;
  name: string;
  status: string;
  managerName: string;
  industry: string | null;
};

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "ACTIVE":
      return (
        <Badge variant="outline" className="text-green-700 border-green-300 bg-green-50 dark:text-green-400 dark:border-green-700 dark:bg-green-950 font-medium">
          ACTIVE
        </Badge>
      );
    case "AT_RISK":
      return (
        <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50 dark:text-amber-400 dark:border-amber-700 dark:bg-amber-950 font-medium">
          AT_RISK
        </Badge>
      );
    case "CHURNED":
      return (
        <Badge variant="outline" className="text-slate-600 border-slate-300 bg-slate-50 dark:text-slate-400 dark:border-slate-600 dark:bg-slate-900 font-medium">
          CHURNED
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="font-medium">
          {status}
        </Badge>
      );
  }
}

export function AccountTable({ rows }: { rows: AccountRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center rounded-lg border border-dashed border-border">
        <Building2 className="size-8 mb-2 opacity-40 text-muted-foreground" />
        <p className="text-muted-foreground text-sm">No accounts yet</p>
        <p className="text-xs text-muted-foreground mt-1">Create your first account to get started</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead className="font-semibold text-foreground">Name</TableHead>
            <TableHead className="font-semibold text-foreground">Status</TableHead>
            <TableHead className="font-semibold text-foreground">Industry</TableHead>
            <TableHead className="font-semibold text-foreground">Account Manager</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id} className="hover:bg-muted/40 transition-colors duration-150 cursor-pointer">
              <TableCell className="font-medium">
                <Link
                  href={`/accounts/${r.id}`}
                  className="text-sky-700 dark:text-sky-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded"
                >
                  {r.name}
                </Link>
              </TableCell>
              <TableCell>
                <StatusBadge status={r.status} />
              </TableCell>
              <TableCell className="text-muted-foreground">{r.industry ?? "—"}</TableCell>
              <TableCell className="text-muted-foreground">{r.managerName}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
