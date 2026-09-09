import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { CompanyCreate } from "./CompanyCreate";
import { UserCreate } from "./UserCreate";

export default async function Page() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "SUPER_ADMIN") redirect("/dashboard");
  const companies = await prisma.company.findMany({
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  return (
    <div className="flex flex-col lg:flex-row items-stretch justify-center">
      <CompanyCreate />
      <UserCreate companies={companies} />
    </div>
  );
}
