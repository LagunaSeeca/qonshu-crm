import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { getTenantContext } from "@/lib/tenant/context";
import { listUsers } from "@/lib/tenant/users";
import { listAccounts } from "@/lib/tenant/accounts";
import { UserAdmin } from "./UserAdmin";

export default async function UsersPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "COMPANY_ADMIN") redirect("/dashboard");
  const [users, accounts] = await Promise.all([
    listUsers(prisma, getTenantContext(user)),
    listAccounts(prisma, user),
  ]);
  return (
    <UserAdmin
      initial={users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name ?? "",
        role: u.role,
        status: u.status,
      }))}
      accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
    />
  );
}
