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
import { OwnerSelectItems } from "@/components/OwnerSelectItems";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Owner = { id: string; name: string; teamId: string | null; teamName: string | null };

type Props = {
  /** People the viewer may assign the account to (listAssignableUsers). Unused for a MEMBER. */
  owners?: Owner[];
  currentUserId: string;
  role: string;
  /** Admin-only: a MEMBER minting a partner login is refused by the server. */
  canGrantPartnerAccess?: boolean;
};

export function AccountCreate({ owners = [], currentUserId, role, canGrantPartnerAccess = false }: Props) {
  const isSuper = role === "SUPER_ADMIN";
  // A member always manages what they create — no picker at all (the server ignores a supplied one).
  const showManagerPicker = role !== "MEMBER";
  // Default to the CURRENT user, never owners[0]: that is usually the admin, and under owner-only
  // visibility a member's own new account would vanish from their view. The owner has no default.
  const defaultManager = isSuper ? "" : currentUserId;
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [industry, setIndustry] = useState("");
  const [primaryContactName, setPrimaryContactName] = useState("");
  const [primaryContactEmail, setPrimaryContactEmail] = useState("");
  const [accountManagerId, setAccountManagerId] = useState(defaultManager);
  const [showPartnerLogin, setShowPartnerLogin] = useState(false);
  const [partnerName, setPartnerName] = useState("");
  const [partnerEmail, setPartnerEmail] = useState("");
  const [partnerPassword, setPartnerPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const managerItems = Object.fromEntries(owners.map((m) => [m.id, m.name]));

  function reset() {
    setName("");
    setWebsite("");
    setIndustry("");
    setPrimaryContactName("");
    setPrimaryContactEmail("");
    setAccountManagerId(defaultManager);
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
    if (showManagerPicker && !accountManagerId) {
      toast.error("Choose who manages this account");
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
          accountManagerId: showManagerPicker ? accountManagerId : undefined,
          partnerLogin: canGrantPartnerAccess && showPartnerLogin && partnerLoginFilled
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
        // building_claimed: another salesperson already registered this building. Show the
        // server's message verbatim and keep the dialog open so the name can be edited.
        const body = await r.json().catch(() => ({}));
        toast.error(body?.error === "building_claimed" && body?.message ? body.message : (body?.message ?? "That login email is already in use"));
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
              Building name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="ac-name"
              placeholder="Residential complex / building"
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
          {/* Read-only by design. The external partner namespace is global, so choosing a partner
              here would let one team pull another's debt, payments and unit-level owner
              names/phones — assignment is SUPER_ADMIN-only (Partner links). */}
          <div className="space-y-1.5">
            <Label>Analytics partner link</Label>
            <p className="rounded-lg border border-input bg-muted/40 px-2.5 py-2 text-sm text-muted-foreground">
              Not linked yet — the owner links the external partner after the account exists.
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
          {showManagerPicker && (
            <div className="space-y-1.5">
              <Label htmlFor="ac-manager">
                Account manager {isSuper && <span className="text-destructive">*</span>}
              </Label>
              <Select items={managerItems} value={accountManagerId} onValueChange={(v) => { if (v !== null) setAccountManagerId(v); }}>
                <SelectTrigger id="ac-manager">
                  <SelectValue placeholder={isSuper ? "Choose a manager" : "Select manager"} />
                </SelectTrigger>
                <SelectContent>
                  <OwnerSelectItems owners={owners} grouped={isSuper} />
                </SelectContent>
              </Select>
            </div>
          )}

          {canGrantPartnerAccess && (
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
          )}
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
