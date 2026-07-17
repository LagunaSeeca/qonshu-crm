import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { listFieldDefs } from "@/lib/tenant/account-fields";
import { FieldSettings } from "./FieldSettings";

export default async function AccountFieldsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "COMPANY_ADMIN") redirect("/accounts");

  const defs = await listFieldDefs(prisma, user);

  return (
    <FieldSettings
      initialDefs={defs.map((d) => ({
        id: d.id,
        label: d.label,
        type: d.type as "TEXT" | "NUMBER" | "CURRENCY" | "DATE",
        order: d.order,
      }))}
    />
  );
}
