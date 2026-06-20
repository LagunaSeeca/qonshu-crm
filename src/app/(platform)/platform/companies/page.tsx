import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { CompanyCreate } from "./CompanyCreate";

export default async function Page() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "SUPER_ADMIN") redirect("/dashboard");
  return <CompanyCreate />;
}
