"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";

type CompanyOption = { id: string; name: string };

const ROLE_LABELS: Record<string, string> = {
  MEMBER: "Sales manager (Member)",
  COMPANY_ADMIN: "Company Admin",
};

export function UserCreate({ companies }: { companies: CompanyOption[] }) {
  const [companyId, setCompanyId] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("MEMBER");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!companyId) {
      toast.error("Pick a target company");
      return;
    }
    setLoading(true);
    try {
      const r = await fetch("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, password, role, companyId }),
      });
      if (r.ok) {
        toast.success("User created — share the email/password with them directly");
        setName("");
        setEmail("");
        setPassword("");
      } else if (r.status === 409) {
        toast.error("A user with that email already exists");
      } else {
        const body = await r.json().catch(() => ({}));
        toast.error(body?.error ?? "Failed to create user");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-sm shadow-sm">
        <CardHeader className="pb-4">
          <p className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
            Platform Admin
          </p>
          <CardTitle className="text-2xl font-bold">New User</CardTitle>
          <CardDescription>Create a user directly in an existing company, without handing off to their admin.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="platform-user-company">Company <span aria-hidden="true">*</span></Label>
              {companies.length === 0 ? (
                <p className="text-sm text-muted-foreground">No companies yet — create one first.</p>
              ) : (
                <Select
                  items={Object.fromEntries(companies.map((c) => [c.id, c.name]))}
                  value={companyId}
                  onValueChange={(v) => setCompanyId(v ?? "")}
                >
                  <SelectTrigger id="platform-user-company" className="w-full">
                    <SelectValue placeholder="Select a company" />
                  </SelectTrigger>
                  <SelectContent>
                    {companies.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="platform-user-name">Name <span aria-hidden="true">*</span></Label>
              <Input
                id="platform-user-name"
                placeholder="Jane Doe"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="platform-user-email">Email <span aria-hidden="true">*</span></Label>
              <Input
                id="platform-user-email"
                type="email"
                placeholder="jane@acme.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="platform-user-password">Password <span aria-hidden="true">*</span></Label>
              <Input
                id="platform-user-password"
                type="password"
                placeholder="Min 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="platform-user-role">Role</Label>
              <Select items={ROLE_LABELS} value={role} onValueChange={(v) => setRole(v ?? "MEMBER")}>
                <SelectTrigger id="platform-user-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MEMBER">Sales manager (Member)</SelectItem>
                  <SelectItem value="COMPANY_ADMIN">Company Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" className="w-full mt-1" disabled={loading || companies.length === 0}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create user
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
