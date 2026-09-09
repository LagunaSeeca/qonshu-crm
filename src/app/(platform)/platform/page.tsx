import { redirect } from "next/navigation";
import Link from "next/link";
import { Building2, Users, Briefcase, Target, Smartphone, DollarSign, Plus, ShieldAlert } from "lucide-react";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { getPlatformOverview } from "@/lib/platform/overview";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function KpiCard({ label, value, icon: Icon }: { label: string; value: string; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <Card size="sm">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
        <Icon className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-xl font-bold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "SUSPENDED") {
    return (
      <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50 dark:text-amber-400 dark:border-amber-700 dark:bg-amber-950 font-medium">
        SUSPENDED
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-green-700 border-green-300 bg-green-50 dark:text-green-400 dark:border-green-700 dark:bg-green-950 font-medium">
      ACTIVE
    </Badge>
  );
}

export default async function PlatformOverviewPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "SUPER_ADMIN") redirect("/dashboard");

  const overview = await getPlatformOverview(prisma, user);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        subtitle="All companies on the platform"
        action={
          <Link href="/platform/companies" className={buttonVariants({ size: "sm" })}>
            <Plus className="h-4 w-4 mr-1.5" />
            New company
          </Link>
        }
      />

      {/* A cross-tenant duplicate means two companies are reading ONE complex's debt, payments
          and unit-level owner names/phones — and the super admin is the only person who can
          unlink one of them. It used to vanish into an anonymous `skipped` count on this page,
          so nobody was told. @@unique([externalPartnerKey]) makes new ones impossible; this
          block is what surfaces anything older than the constraint. */}
      {overview.duplicatePartners.length > 0 && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950">
          <div className="flex items-center gap-2 text-red-800 dark:text-red-300">
            <ShieldAlert className="size-4 shrink-0" />
            <p className="text-sm font-semibold">
              {overview.duplicatePartners.length === 1
                ? "1 complex is claimed by more than one account"
                : `${overview.duplicatePartners.length} complexes are claimed by more than one account`}
            </p>
          </div>
          <p className="mt-1 text-xs text-red-800/80 dark:text-red-300/80">
            Every account below reads the same external complex, so its debt, payments and unit
            owners are exposed to each of their companies, and its figures are double-counted
            above. Clear the link on all but one, on the Partner links page.
          </p>
          <ul className="mt-2 space-y-1">
            {overview.duplicatePartners.map((d) => (
              <li key={d.partnerName} className="text-xs text-red-900 dark:text-red-200">
                <span className="font-medium">{d.partnerName}</span>
                <span className="text-red-800/80 dark:text-red-300/80">
                  {" — "}
                  {d.accounts
                    .map((a) => `account ${a.id} (company ${a.companyId})`)
                    .join(", ")}
                </span>
              </li>
            ))}
          </ul>
          <Link
            href="/platform/accounts"
            className="mt-2 inline-block text-xs font-medium underline text-red-900 dark:text-red-200"
          >
            Go to Partner links
          </Link>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <KpiCard label="Companies" value={overview.totals.companies.toLocaleString()} icon={Building2} />
        <KpiCard label="Users" value={overview.totals.users.toLocaleString()} icon={Users} />
        <KpiCard label="Accounts" value={overview.totals.accounts.toLocaleString()} icon={Briefcase} />
        <KpiCard label="Leads" value={overview.totals.leads.toLocaleString()} icon={Target} />
        <KpiCard label="App users" value={overview.totals.appUsers.toLocaleString()} icon={Smartphone} />
        <KpiCard label="Payments amount" value={money(overview.totals.paymentsAmount)} icon={DollarSign} />
      </div>

      {overview.companies.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center rounded-lg border border-dashed border-border">
          <Building2 className="size-8 mb-2 opacity-40 text-muted-foreground" />
          <p className="text-muted-foreground text-sm">No companies yet</p>
          <p className="text-xs text-muted-foreground mt-1">Create the first company to get started</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="font-semibold text-foreground">Name</TableHead>
                <TableHead className="font-semibold text-foreground">Status</TableHead>
                <TableHead className="font-semibold text-foreground">Users</TableHead>
                <TableHead className="font-semibold text-foreground">Accounts</TableHead>
                <TableHead className="font-semibold text-foreground">Leads</TableHead>
                <TableHead className="font-semibold text-foreground">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overview.companies.map((c) => (
                <TableRow key={c.id} className="hover:bg-muted/40 transition-colors duration-150">
                  <TableCell className="font-medium">
                    {c.name}
                    <span className="block text-xs text-muted-foreground font-normal">{c.slug}</span>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={c.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{c.users.toLocaleString()}</TableCell>
                  <TableCell className="text-muted-foreground">{c.accounts.toLocaleString()}</TableCell>
                  <TableCell className="text-muted-foreground">{c.leads.toLocaleString()}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {c.createdAt.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
