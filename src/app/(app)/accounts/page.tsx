import { redirect } from "next/navigation";
import Link from "next/link";
import { Settings2 } from "lucide-react";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { getTenantContext } from "@/lib/tenant/context";
import { listAccounts } from "@/lib/tenant/accounts";
import { listUsers } from "@/lib/tenant/users";
import { AccountCreate } from "./AccountCreate";
import { AccountTable, type AccountRow } from "./AccountTable";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/PageHeader";

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const ctx = getTenantContext(user);
  const sp = await searchParams;

  const [accounts, members] = await Promise.all([
    listAccounts(prisma, user, { q: sp.q }),
    listUsers(prisma, ctx),
  ]);

  const userMap = Object.fromEntries(members.map((u) => [u.id, u.name ?? u.email]));

  const rows: AccountRow[] = accounts.map((a) => ({
    id: a.id,
    name: a.name,
    status: a.status,
    managerName: a.accountManagerId ? (userMap[a.accountManagerId] ?? "—") : "—",
    industry: a.industry,
  }));

  return (
    <div className="space-y-6">
      <PageHeader title="Accounts" subtitle="All accounts in your organization" />

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Search form */}
        <form method="GET" className="flex items-center gap-2 flex-1">
          <Input
            name="q"
            defaultValue={sp.q ?? ""}
            placeholder="Search accounts..."
            className="h-8 text-sm max-w-xs"
          />
          <button
            type="submit"
            className="h-8 px-3 rounded-md border border-input bg-muted text-sm font-medium hover:bg-muted/70 transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-ring"
          >
            Search
          </button>
        </form>

        {/* New Account button */}
        <div className="ml-auto flex items-center gap-3">
          {user.role === "COMPANY_ADMIN" && (
            <Link
              href="/accounts/fields"
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-input bg-muted text-sm font-medium hover:bg-muted/70 transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <Settings2 className="size-3.5" />
              Custom fields
            </Link>
          )}
          <AccountCreate members={members.map((m) => ({ id: m.id, name: m.name, email: m.email }))} />
        </div>
      </div>

      {/* Table */}
      <AccountTable rows={rows} />
    </div>
  );
}
