"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type AllowlistEntry = {
  id: string;
  partnerName: string;
  companyId: string;
  companyName: string;
};

export type CompanyOption = { id: string; name: string };

type Partner = { name: string; type: string };
// Same source as the assignment card below it: GET /api/partners is SUPER_ADMIN-only and already
// hides partners claimed by an account, so this offers exactly the complexes still up for grabs.
type PartnerListState =
  | { status: "loading" }
  | { status: "ready"; partners: Partner[] }
  | { status: "not_configured" }
  | { status: "error" };

const ERROR_MESSAGES: Record<string, string> = {
  partner_already_granted: "That complex is already granted to a company. Revoke it first.",
  partner_linked_elsewhere: "An account in another company is already linked to that complex. Clear the link first.",
  forbidden: "Only a platform admin can manage the allowlist.",
  not_found: "That company no longer exists.",
};

export function PartnerAllowlistManager({
  entries,
  companies,
}: {
  entries: AllowlistEntry[];
  companies: CompanyOption[];
}) {
  const router = useRouter();
  const [partnerName, setPartnerName] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [saving, setSaving] = useState(false);
  const [list, setList] = useState<PartnerListState>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/partners");
        const body = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (r.ok && body?.status === "not_configured") return setList({ status: "not_configured" });
        if (!r.ok || !Array.isArray(body?.partners)) return setList({ status: "error" });
        setList({ status: "ready", partners: body.partners });
      } catch {
        if (!cancelled) setList({ status: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  function reloadPartners() {
    setList({ status: "loading" });
    setReloadToken((n) => n + 1);
  }

  async function grant() {
    if (!partnerName || !companyId) return;
    setSaving(true);
    try {
      const r = await fetch("/api/platform/partner-allowlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ partnerName, companyId }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        toast.error(ERROR_MESSAGES[body?.error] ?? "Failed to grant the complex");
        return;
      }
      toast.success(`"${partnerName}" granted`);
      setPartnerName("");
      setCompanyId("");
      reloadPartners();
      router.refresh();
    } catch {
      toast.error("Failed to grant the complex");
    } finally {
      setSaving(false);
    }
  }

  async function revoke(entry: AllowlistEntry) {
    setSaving(true);
    try {
      const r = await fetch(`/api/platform/partner-allowlist/${entry.id}`, { method: "DELETE" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        toast.error(ERROR_MESSAGES[body?.error] ?? "Failed to revoke the grant");
        return;
      }
      toast.success(`"${entry.partnerName}" revoked`);
      router.refresh();
    } catch {
      toast.error("Failed to revoke the grant");
    } finally {
      setSaving(false);
    }
  }

  const companyItems = Object.fromEntries(companies.map((c) => [c.id, c.name]));
  const partnerItems =
    list.status === "ready" ? Object.fromEntries(list.partners.map((p) => [p.name, p.name])) : {};
  const canGrant = partnerName.length > 0 && companyId.length > 0 && !saving;

  return (
    <Card className="w-full max-w-lg shadow-sm">
      <CardHeader className="pb-4">
        <CardTitle>Allowlist</CardTitle>
        <CardDescription>
          Which company is allowed to auto-link to which complex. An account whose name matches a
          complex links itself ONLY if that complex is granted to its company here — everything
          else stays unlinked, with no hint that the complex exists.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="al-partner">Complex</Label>
          {list.status === "loading" ? (
            <p className="text-sm text-muted-foreground">Loading partners…</p>
          ) : list.status === "not_configured" ? (
            <p className="text-sm text-muted-foreground">
              PARTNER_API_KEY isn&apos;t configured, so there is no live partner list.
            </p>
          ) : list.status === "error" ? (
            <p className="text-sm text-amber-600 dark:text-amber-400">
              Couldn&apos;t load the partner list.{" "}
              <button type="button" onClick={reloadPartners} className="underline cursor-pointer">
                Retry
              </button>
            </p>
          ) : list.partners.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Every live partner is already linked to an account.
            </p>
          ) : (
            <Select
              items={partnerItems}
              value={partnerName}
              onValueChange={(v) => setPartnerName(v ?? "")}
            >
              <SelectTrigger id="al-partner" className="w-full">
                <SelectValue placeholder="Select a complex" />
              </SelectTrigger>
              <SelectContent>
                {list.partners.map((p) => (
                  <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="al-company">Company</Label>
          {companies.length === 0 ? (
            <p className="text-sm text-muted-foreground">No companies on the platform yet.</p>
          ) : (
            <Select
              items={companyItems}
              value={companyId}
              onValueChange={(v) => setCompanyId(v ?? "")}
            >
              <SelectTrigger id="al-company" className="w-full">
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

        <div className="pt-1">
          <Button type="button" onClick={() => void grant()} disabled={!canGrant}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Grant
          </Button>
        </div>

        <div className="space-y-1.5 border-t border-border pt-4">
          <p className="text-sm font-medium">Current grants</p>
          {entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing granted yet — no account can auto-link to any complex.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {entries.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-2 py-2">
                  <span className="text-sm">
                    <span className="font-medium">{e.partnerName}</span>
                    <span className="text-muted-foreground"> → {e.companyName}</span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={saving}
                    onClick={() => void revoke(e)}
                    aria-label={`Revoke ${e.partnerName}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground pt-1">
            Revoking removes future auto-linking only. An account already holding the link keeps it
            until it is cleared below.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
