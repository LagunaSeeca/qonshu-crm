"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Combobox } from "@base-ui/react/combobox";
import { Plus, ChevronDown, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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

type Partner = { name: string; type: string };
type PartnerListState =
  | { status: "loading" }
  | { status: "ready"; partners: Partner[] }
  | { status: "error" };

function usePartnerList(): PartnerListState {
  const [state, setState] = useState<PartnerListState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/partners");
        if (!r.ok) throw new Error("request failed");
        const body = await r.json();
        if (!Array.isArray(body?.partners)) throw new Error("unexpected response shape");
        if (!cancelled) setState({ status: "ready", partners: body.partners });
      } catch {
        if (!cancelled) setState({ status: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

function formatPartnerType(type: string) {
  return type.length > 0 ? type.charAt(0) + type.slice(1).toLowerCase() : type;
}

function PartnerTypeBadge({ type }: { type: string }) {
  const cls =
    type === "RESIDENTIAL"
      ? "text-sky-700 border-sky-300 bg-sky-50 dark:text-sky-400 dark:border-sky-700 dark:bg-sky-950"
      : type === "COMMERCIAL"
      ? "text-violet-700 border-violet-300 bg-violet-50 dark:text-violet-400 dark:border-violet-700 dark:bg-violet-950"
      : "text-muted-foreground";
  return (
    <Badge variant="outline" className={`h-4 shrink-0 px-1.5 py-0 text-[10px] font-medium ${cls}`}>
      {formatPartnerType(type)}
    </Badge>
  );
}

/**
 * Searchable partner picker bound to `externalPartnerKey`. Falls back to a plain
 * text input whenever the partner list can't be loaded, so saving is never blocked.
 */
function PartnerPicker({
  id,
  value,
  onChange,
  description,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  description: string;
}) {
  const state = usePartnerList();

  if (state.status === "loading") {
    return <Input id={id} value={value} placeholder="Loading partners…" disabled readOnly />;
  }

  if (state.status === "error") {
    return (
      <>
        <Input
          id={id}
          placeholder="Company name as known to the analytics provider"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Couldn&apos;t load the partner list — enter the exact partner name manually.
        </p>
      </>
    );
  }

  const { partners } = state;
  const typeByName = Object.fromEntries(partners.map((p) => [p.name, p.type]));
  const isStale = value.length > 0 && !(value in typeByName);

  return (
    <>
      <Combobox.Root
        items={partners.map((p) => p.name)}
        value={value.length > 0 ? value : null}
        onValueChange={(v) => onChange(v ?? "")}
      >
        <Combobox.InputGroup className="flex h-8 w-full items-center gap-0.5 rounded-lg border border-input bg-transparent pl-2.5 pr-1 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50">
          <Combobox.Input
            id={id}
            placeholder="Search partners…"
            className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <Combobox.Clear
            aria-label="Clear partner selection"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-3.5" />
          </Combobox.Clear>
          <Combobox.Trigger
            aria-label="Show all partners"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown className="size-3.5" />
          </Combobox.Trigger>
        </Combobox.InputGroup>
        <Combobox.Portal>
          <Combobox.Positioner sideOffset={4} className="isolate z-50 outline-none">
            <Combobox.Popup className="relative max-h-(--available-height) w-(--anchor-width) min-w-[14rem] origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
              <Combobox.Empty className="px-3 py-4 text-center text-sm text-muted-foreground">
                {partners.length === 0 ? "No partners available yet." : "No partners match your search."}
              </Combobox.Empty>
              <Combobox.List className="p-1">
                {(name: string) => (
                  <Combobox.Item
                    key={name}
                    value={name}
                    className="relative flex w-full cursor-default items-center gap-2 rounded-md py-1.5 pr-2 pl-1.5 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                  >
                    <Combobox.ItemIndicator className="flex size-4 shrink-0 items-center justify-center">
                      <Check className="size-3.5" />
                    </Combobox.ItemIndicator>
                    <span className="flex-1 truncate">{name}</span>
                    <PartnerTypeBadge type={typeByName[name]} />
                  </Combobox.Item>
                )}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
      {isStale ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          &ldquo;{value}&rdquo; is not in the current partner list (renamed or removed) — kept as-is.
        </p>
      ) : partners.length === 0 ? (
        <p className="text-xs text-muted-foreground">No partners returned by the analytics API yet.</p>
      ) : (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
    </>
  );
}

export function AccountCreate({ members, isAdmin = false }: { members: Member[]; isAdmin?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [industry, setIndustry] = useState("");
  const [primaryContactName, setPrimaryContactName] = useState("");
  const [primaryContactEmail, setPrimaryContactEmail] = useState("");
  const [externalPartnerKey, setExternalPartnerKey] = useState("");
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
    setExternalPartnerKey("");
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
          externalPartnerKey: externalPartnerKey || undefined,
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
          <div className="space-y-1.5">
            <Label htmlFor="ac-partner-key">Partner name for analytics API</Label>
            <PartnerPicker
              id="ac-partner-key"
              value={externalPartnerKey}
              onChange={setExternalPartnerKey}
              description="Used to pull this partner's app users, payments & debt from the external API. Leave blank until you have it."
            />
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
