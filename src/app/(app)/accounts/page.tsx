import { redirect } from "next/navigation";
import Link from "next/link";
import { Settings2 } from "lucide-react";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { isAdmin } from "@/lib/auth/guards";
import { listAccounts } from "@/lib/tenant/accounts";
import { loadOwnerOptions, loadTeams } from "../_lib/pickers";
import { AccountCreate } from "./AccountCreate";
import { AccountTable, type AccountRow } from "./AccountTable";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/PageHeader";

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const sp = await searchParams;

  const teams = await loadTeams(user);
  const [accounts, owners] = await Promise.all([
    listAccounts(prisma, user, { q: sp.q }),
    loadOwnerOptions(user, teams),
  ]);

  // Managers can be people the viewer cannot assign to (deactivated, or another team's for the
  // owner), so table names are looked up directly rather than taken from the picker list.
  const managerIds = [...new Set(accounts.map((a) => a.accountManagerId).filter((x): x is string => !!x))];
  const managers = managerIds.length
    ? await prisma.user.findMany({ where: { id: { in: managerIds } }, select: { id: true, name: true, email: true } })
    : [];
  const userMap = Object.fromEntries(managers.map((u) => [u.id, u.name ?? u.email]));

  const rows: AccountRow[] = accounts.map((a) => ({
    id: a.id,
    name: a.name,
    status: a.status,
    managerName: a.accountManagerId ? (userMap[a.accountManagerId] ?? "—") : "—",
    industry: a.industry,
  }));

  return (
    <div className="space-y-6">
      <PageHeader title="Accounts" subtitle="Buildings you manage" />

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Search form */}
        <form method="GET" className="flex items-center gap-2 flex-1">
          <Input
            name="q"
            aria-label="Search accounts"
            defaultValue={sp.q ?? ""}
            placeholder="Search accounts..."
            className="h-8 text-sm max-w-xs"
          />
          <button
            type="submit"
            className="h-8 px-3 rounded-md border border-input bg-muted text-sm font-medium hover:bg-muted/70 transition-colors duration-150 cursor-pointer focus:outline-none focus:ring-2 focus:ring-ring"
          >
            Search
          </button>
        </form>

        {/* New Account button */}
        <div className="ml-auto flex items-center gap-3">
          {isAdmin(user) && (
            <Link
              href="/accounts/fields"
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-input bg-muted text-sm font-medium hover:bg-muted/70 transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <Settings2 className="size-3.5" />
              Custom fields
            </Link>
          )}
          <AccountCreate owners={owners} currentUserId={user.id} role={user.role} canGrantPartnerAccess={isAdmin(user)} />
        </div>
      </div>

      {/* Table */}
      <AccountTable rows={rows} />
    </div>
  );
}
