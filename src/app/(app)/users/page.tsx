import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { getTenantContext } from "@/lib/tenant/context";
import { listUsers } from "@/lib/tenant/users";
import { UserAdmin } from "./UserAdmin";

export default async function UsersPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "COMPANY_ADMIN") redirect("/dashboard");
  const users = await listUsers(prisma, getTenantContext(user));
  return (
    <UserAdmin
      initial={users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name ?? "",
        role: u.role,
        status: u.status,
      }))}
    />
  );
}
