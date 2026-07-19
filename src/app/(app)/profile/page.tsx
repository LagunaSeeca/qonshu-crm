import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { PageHeader } from "@/components/PageHeader";
import { ProfileForm } from "./ProfileForm";

export default async function ProfilePage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  return (
    <div className="space-y-6">
      <PageHeader title="Profile" subtitle="Manage your account settings" />

      <ProfileForm />
    </div>
  );
}
