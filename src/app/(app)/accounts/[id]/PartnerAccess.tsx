"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { KeyRound, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

export type PartnerLogin = { id: string; name: string; email: string; status: string };

// The building's representative login. A building has at most ONE active rep (the API answers 409
// `partner_login_exists` otherwise), so this card either shows that person or offers the create
// form. The sales manager of the building can create it — no team-admin round trip.
export function PartnerAccess({ accountId, logins }: { accountId: string; logins: PartnerLogin[] }) {
  const router = useRouter();
  const active = logins.find((l) => l.status === "ACTIVE") ?? null;
  const inactiveCount = logins.length - (active ? 1 : 0);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(`/api/accounts/${accountId}/partner-login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      if (res.ok) {
        toast.success("Representative login created — share the email and password with them directly.");
        setName("");
        setEmail("");
        setPassword("");
        router.refresh();
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (res.status === 409 && body?.error === "partner_login_exists") {
        toast.error("This building already has an active representative. Deactivate them before issuing a new login.");
        router.refresh();
      } else if (res.status === 409) {
        toast.error("That email is already in use by another login.");
      } else if (res.status === 400) {
        toast.error("Check the name, email and password (at least 8 characters).");
      } else {
        toast.error("Failed to create the representative login.");
      }
    } catch {
      toast.error("Failed to create the representative login.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader className="border-b border-border pb-4">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />
          Partner access
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4">
        {active ? (
          <div className="space-y-1 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground">{active.name}</span>
              <Badge variant="outline" className="text-xs">Active</Badge>
            </div>
            <p className="text-muted-foreground">{active.email}</p>
            <p className="text-xs text-muted-foreground pt-1">
              This is the building&apos;s representative. A building has one active login at a time.
            </p>
          </div>
        ) : (
          <form onSubmit={create} className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Give the building&apos;s representative a read-only login. They see only this building&apos;s
              analytics, settlements and service fees.
              {inactiveCount > 0 && ` (${inactiveCount} earlier login${inactiveCount > 1 ? "s are" : " is"} deactivated.)`}
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="pa-name">Name</Label>
              <Input id="pa-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pa-email">Login email</Label>
              <Input id="pa-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pa-password">Password</Label>
              <Input
                id="pa-password"
                type="password"
                placeholder="Min 8 characters"
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={saving || password.length < 8}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create login
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
