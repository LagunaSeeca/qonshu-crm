import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export type LeadRow = {
  id: string;
  title: string;
  contactName: string;
  stageName: string;
  priority: string;
  ownerName: string;
};

function StageBadge({ name }: { name: string }) {
  // Heuristic: color by common stage-type conventions
  const lower = name.toLowerCase();
  if (lower === "won") {
    return (
      <Badge variant="outline" className="text-green-700 border-green-300 bg-green-50 dark:text-green-400 dark:border-green-700 dark:bg-green-950 font-medium">
        {name}
      </Badge>
    );
  }
  if (lower === "lost") {
    return (
      <Badge variant="outline" className="text-red-700 border-red-300 bg-red-50 dark:text-red-400 dark:border-red-700 dark:bg-red-950 font-medium">
        {name}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-sky-700 border-sky-300 bg-sky-50 dark:text-sky-400 dark:border-sky-700 dark:bg-sky-950 font-medium">
      {name}
    </Badge>
  );
}

function PriorityBadge({ priority }: { priority: string }) {
  switch (priority) {
    case "HIGH":
      return (
        <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50 dark:text-amber-400 dark:border-amber-700 dark:bg-amber-950 font-medium">
          HIGH
        </Badge>
      );
    case "LOW":
      return (
        <Badge variant="outline" className="text-slate-600 border-slate-300 bg-slate-50 dark:text-slate-400 dark:border-slate-600 dark:bg-slate-900 font-medium">
          LOW
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="text-sky-700 border-sky-300 bg-sky-50 dark:text-sky-400 dark:border-sky-700 dark:bg-sky-950 font-medium">
          MEDIUM
        </Badge>
      );
  }
}

export function LeadTable({ rows }: { rows: LeadRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center rounded-lg border border-dashed border-border">
        <p className="text-muted-foreground text-sm">No leads yet</p>
        <p className="text-xs text-muted-foreground mt-1">Create your first lead to get started</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead className="font-semibold text-foreground">Title</TableHead>
            <TableHead className="font-semibold text-foreground">Contact</TableHead>
            <TableHead className="font-semibold text-foreground">Stage</TableHead>
            <TableHead className="font-semibold text-foreground">Owner</TableHead>
            <TableHead className="font-semibold text-foreground">Priority</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id} className="hover:bg-muted/40 transition-colors duration-150 cursor-pointer">
              <TableCell className="font-medium">
                <Link
                  href={`/crm/${r.id}`}
                  className="text-sky-700 dark:text-sky-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded"
                >
                  {r.title}
                </Link>
              </TableCell>
              <TableCell className="text-muted-foreground">{r.contactName}</TableCell>
              <TableCell>
                <StageBadge name={r.stageName} />
              </TableCell>
              <TableCell className="text-muted-foreground">{r.ownerName}</TableCell>
              <TableCell>
                <PriorityBadge priority={r.priority} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
