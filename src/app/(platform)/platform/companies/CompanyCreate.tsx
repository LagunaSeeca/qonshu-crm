"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";

export function CompanyCreate() {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const r = await fetch("/api/platform/companies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, slug, adminEmail }),
      });
      if (r.ok) {
        toast.success("Company created — admin invite logged to server console");
        setName("");
        setSlug("");
        setAdminEmail("");
      } else {
        const body = await r.json().catch(() => ({}));
        toast.error(body?.error ?? "Failed to create company");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm shadow-sm">
        <CardHeader className="pb-4">
          <p className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
            Platform Admin
          </p>
          <CardTitle className="text-2xl font-bold">New Company</CardTitle>
          <CardDescription>Create a new tenant and invite the admin.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="company-name">Company name <span aria-hidden="true">*</span></Label>
              <Input
                id="company-name"
                placeholder="Acme Corp"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="company-slug">Slug <span aria-hidden="true">*</span></Label>
              <Input
                id="company-slug"
                placeholder="acme-corp"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="admin-email">Admin email <span aria-hidden="true">*</span></Label>
              <Input
                id="admin-email"
                type="email"
                placeholder="admin@acme.com"
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                required
              />
            </div>
            <Button type="submit" className="w-full mt-1" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create company
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
