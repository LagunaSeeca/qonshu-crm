import { redirect } from "next/navigation";
import Link from "next/link";
import { Landmark, ArrowDownCircle, ArrowUpCircle } from "lucide-react";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { listCompanySettlements } from "@/lib/tenant/settlements";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AddSettlementEntry } from "./AddSettlementEntry";
import { PageHeader } from "@/components/PageHeader";

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export default async function SettlementsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const { totals, rows } = await listCompanySettlements(prisma, user);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settlements"
        subtitle="Company-wide bank-balance and cash-transfer registry"
        action={
          user.role === "COMPANY_ADMIN" && (
            <AddSettlementEntry accounts={rows.map((r) => ({ id: r.accountId, name: r.accountName }))} />
          )
        }
      />

      {/* Totals */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card size="sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Collected</CardTitle>
            <ArrowDownCircle className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold tabular-nums">{money(totals.collected)}</div>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Transferred</CardTitle>
            <ArrowUpCircle className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold tabular-nums">{money(totals.transferred)}</div>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Owed</CardTitle>
            <Landmark className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums text-foreground">{money(totals.owed)}</div>
          </CardContent>
        </Card>
      </div>

      {/* Registry by partner */}
      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center rounded-lg border border-dashed border-border">
          <p className="text-muted-foreground text-sm">No accounts yet</p>
          <p className="text-xs text-muted-foreground mt-1">Settlement balances will appear once accounts have entries</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="font-semibold text-foreground">Partner</TableHead>
                <TableHead className="text-right font-semibold text-foreground">Collected</TableHead>
                <TableHead className="text-right font-semibold text-foreground">Transferred</TableHead>
                <TableHead className="text-right font-semibold text-foreground">Owed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.accountId} className="hover:bg-muted/40 transition-colors duration-150">
                  <TableCell className="font-medium">
                    <Link
                      href={`/accounts/${r.accountId}`}
                      className="text-sky-700 dark:text-sky-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded"
                    >
                      {r.accountName}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(r.collected)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(r.transferred)}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{money(r.owed)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
