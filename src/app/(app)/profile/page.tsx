import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { ProfileForm } from "./ProfileForm";

export default async function ProfilePage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Profile</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage your account settings</p>
      </div>

      <ProfileForm />
    </div>
  );
}
