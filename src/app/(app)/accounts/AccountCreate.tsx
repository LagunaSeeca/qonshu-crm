"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Member = { id: string; name: string | null; email: string };

export function AccountCreate({ members, isAdmin = false }: { members: Member[]; isAdmin?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [industry, setIndustry] = useState("");
  const [primaryContactName, setPrimaryContactName] = useState("");
  const [primaryContactEmail, setPrimaryContactEmail] = useState("");
  const [accountManagerId, setAccountManagerId] = useState(members[0]?.id ?? "");
  const [showPartnerLogin, setShowPartnerLogin] = useState(false);
  const [partnerName, setPartnerName] = useState("");
  const [partnerEmail, setPartnerEmail] = useState("");
  const [partnerPassword, setPartnerPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const managerItems = Object.fromEntries(members.map((m) => [m.id, m.name ?? m.email]));

  function reset() {
    setName("");
    setWebsite("");
    setIndustry("");
    setPrimaryContactName("");
    setPrimaryContactEmail("");
    setAccountManagerId(members[0]?.id ?? "");
    setShowPartnerLogin(false);
    setPartnerName("");
    setPartnerEmail("");
    setPartnerPassword("");
  }

  const partnerLoginFilled = partnerEmail.trim().length > 0 && partnerPassword.length > 0;
  const partnerLoginInvalid = showPartnerLogin && partnerLoginFilled && partnerPassword.length < 8;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (partnerLoginInvalid) {
      toast.error("Partner login password must be at least 8 characters");
      return;
    }
    setLoading(true);
    try {
      const r = await fetch("/api/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          website: website || undefined,
          industry: industry || undefined,
          primaryContactName: primaryContactName || undefined,
          primaryContactEmail: primaryContactEmail || undefined,
          accountManagerId: accountManagerId || undefined,
          partnerLogin: showPartnerLogin && partnerLoginFilled
            ? { name: partnerName || name, email: partnerEmail, password: partnerPassword }
            : undefined,
        }),
      });
      if (r.ok) {
        const body = await r.json().catch(() => ({}));
        toast.success(body?.partnerUser ? "Account created + partner login" : "Account created");
        reset();
        setOpen(false);
        router.refresh();
      } else if (r.status === 409) {
        toast.error("That login email is already in use");
      } else {
        const body = await r.json().catch(() => ({}));
        toast.error(body?.error ?? "Failed to create account");
      }
    } catch {
      toast.error("Failed to create account");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm"><Plus className="h-4 w-4 mr-1.5" />New Account</Button>} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create account</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} id="account-create-form" className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="ac-name">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="ac-name"
              placeholder="Account name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ac-website">Website</Label>
            <Input
              id="ac-website"
              placeholder="https://example.com"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ac-industry">Industry</Label>
            <Input
              id="ac-industry"
              placeholder="e.g. SaaS"
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
            />
          </div>
          {/* Read-only by design. The external partner namespace is shared across every
              company on the platform, so choosing a partner here would let one tenant pull
              another's debt, payments and unit-level owner names/phones — assignment is
              SUPER_ADMIN-only now (Platform Admin -> Partner links). A new account auto-links
              itself ONLY when its name matches a complex a platform admin has granted to THIS
              company on the allowlist — the name alone carries no authority, since it is free
              text this form supplies. */}
          <div className="space-y-1.5">
            <Label>Analytics partner link</Label>
            <p className="rounded-lg border border-input bg-muted/40 px-2.5 py-2 text-sm text-muted-foreground">
              Not linked yet — linked automatically only if this company has been granted a
              matching complex; otherwise a platform admin assigns it.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ac-contact-name">Primary contact name</Label>
            <Input
              id="ac-contact-name"
              placeholder="Contact name"
              value={primaryContactName}
              onChange={(e) => setPrimaryContactName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ac-contact-email">Primary contact email</Label>
            <Input
              id="ac-contact-email"
              type="email"
              placeholder="contact@example.com"
              value={primaryContactEmail}
              onChange={(e) => setPrimaryContactEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ac-manager">Account manager</Label>
            <Select items={managerItems} value={accountManagerId} onValueChange={(v) => { if (v !== null) setAccountManagerId(v); }}>
              <SelectTrigger id="ac-manager">
                <SelectValue placeholder="Select manager" />
              </SelectTrigger>
              <SelectContent>
                {members.map((m) => (
                  <SelectItem key={m.id} value={m.id}>{m.name ?? m.email}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="border-t border-border pt-3">
            <button
              type="button"
              onClick={() => setShowPartnerLogin((v) => !v)}
              className="flex w-full items-center justify-between text-sm font-medium text-foreground cursor-pointer"
              aria-expanded={showPartnerLogin}
            >
              Give this partner portal access (optional)
              <ChevronDown
                className={`h-4 w-4 text-muted-foreground transition-transform duration-150 ${showPartnerLogin ? "rotate-180" : ""}`}
              />
            </button>
            {showPartnerLogin && (
              <div className="space-y-4 pt-3">
                <p className="text-xs text-muted-foreground">
                  The partner signs in with this email/password and sees only their own analytics & records.
                </p>
                <div className="space-y-1.5">
                  <Label htmlFor="ac-partner-name">Name</Label>
                  <Input
                    id="ac-partner-name"
                    placeholder="Defaults to account name"
                    value={partnerName}
                    onChange={(e) => setPartnerName(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ac-partner-email">Login email</Label>
                  <Input
                    id="ac-partner-email"
                    type="email"
                    placeholder="partner@example.com"
                    value={partnerEmail}
                    onChange={(e) => setPartnerEmail(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ac-partner-password">Password</Label>
                  <Input
                    id="ac-partner-password"
                    type="password"
                    placeholder="Min 8 characters"
                    value={partnerPassword}
                    onChange={(e) => setPartnerPassword(e.target.value)}
                    minLength={8}
                  />
                  {partnerLoginInvalid && (
                    <p className="text-xs text-destructive">Password must be at least 8 characters</p>
                  )}
                </div>
              </div>
            )}
          </div>
        </form>
        <DialogFooter className="pt-2">
          <Button variant="outline" type="button" onClick={() => setOpen(false)} disabled={loading}>
            Cancel
          </Button>
          <Button type="submit" form="account-create-form" disabled={loading || partnerLoginInvalid}>
            {loading ? "Creating…" : "Create account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
