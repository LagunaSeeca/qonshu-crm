import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { getCurrentUser } from "@/lib/tenant/me";
import { prisma } from "@/db/client";
import { PlatformShell } from "@/components/PlatformShell";

export default async function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const sessionUser = await getSessionUser();
  if (!sessionUser) redirect("/login");
  if (sessionUser.role !== "SUPER_ADMIN") redirect("/dashboard");

  const currentUser = await getCurrentUser(prisma, sessionUser);

  return (
    <PlatformShell userName={currentUser.name} userEmail={currentUser.email}>
      {children}
    </PlatformShell>
  );
}
