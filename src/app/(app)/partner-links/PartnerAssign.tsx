"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
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

export type AccountOption = {
  id: string;
  name: string;
  companyName: string;
  // The CONFIRMED link only. A pending proposal is reported separately so it is never shown in the
  // "currently linked to" slot — a pending key authorizes nothing, and printing it there is how an
  // owner comes to believe data is already flowing.
  externalPartnerKey: string | null;
  partnerLinkPending: boolean;
};

type Partner = { name: string; type: string };
// GET /api/partners is SUPER_ADMIN-only and already excludes partners claimed by any account,
// so whatever comes back here is exactly the set that is safe to assign.
type PartnerListState =
  | { status: "loading" }
  | { status: "ready"; partners: Partner[] }
  | { status: "not_configured" }
  | { status: "error" };

const ERROR_MESSAGES: Record<string, string> = {
  partner_already_claimed: "That partner is already linked to another account.",
  partner_name_held:
    "Another lead or account already claims that building. Reassign that record first.",
  building_claimed:
    "Another lead or account already claims that building. Reassign that record first.",
  unknown_partner: "That partner is no longer in the live list — refresh and try again.",
  partner_api_unavailable: "The partner API is unreachable, so the name can't be verified.",
  forbidden: "Only the owner can change partner links.",
  not_found: "That account no longer exists.",
};

export function PartnerAssign({ accounts }: { accounts: AccountOption[] }) {
  const router = useRouter();
  const [accountId, setAccountId] = useState("");
  const [partnerName, setPartnerName] = useState("");
  const [saving, setSaving] = useState(false);
  const [list, setList] = useState<PartnerListState>({ status: "loading" });
  // Bumped to re-fetch: on Retry, and after every save (a save changes the claimed set, so the
  // unclaimed list is stale in both directions). Kept as a dependency rather than an imperative
  // loader so the fetch stays inside the effect and never setStates synchronously.
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

  const selected = accounts.find((a) => a.id === accountId) ?? null;

  async function save(nextKey: string | null) {
    if (!selected) return;
    setSaving(true);
    try {
      const r = await fetch(`/api/platform/accounts/${selected.id}/partner`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ externalPartnerKey: nextKey }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        // building_claimed / partner_name_held carry the server's own message, which names the
        // record holding the building; show it verbatim. The assignment form stays as it is so the
        // admin can pick a different partner.
        toast.error(
          (body?.error === "building_claimed" || body?.error === "partner_name_held") && body?.message
            ? body.message
            : (ERROR_MESSAGES[body?.error] ?? body?.message ?? "Failed to update the partner link"),
        );
        return;
      }
      toast.success(nextKey ? `Linked to "${nextKey}"` : "Partner link cleared");
      setPartnerName("");
      reloadPartners();
      router.refresh();
    } catch {
      toast.error("Failed to update the partner link");
    } finally {
      setSaving(false);
    }
  }

  const accountItems = Object.fromEntries(
    accounts.map((a) => [a.id, `${a.companyName} — ${a.name}`]),
  );
  const partnerItems =
    list.status === "ready" ? Object.fromEntries(list.partners.map((p) => [p.name, p.name])) : {};
  const canAssign = Boolean(selected) && partnerName.length > 0 && !saving;

  return (
    <Card className="w-full max-w-lg shadow-sm">
      <CardHeader className="pb-4">
        <CardTitle>Partner link</CardTitle>
        <CardDescription>
          The external partner namespace is shared across every team, so linking an account to
          a partner is an owner-only action. Team admins and members see the link read-only.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="pa-account">Account</Label>
          {accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No accounts yet.</p>
          ) : (
            <Select
              items={accountItems}
              value={accountId}
              onValueChange={(v) => {
                setAccountId(v ?? "");
                setPartnerName("");
              }}
            >
              <SelectTrigger id="pa-account" className="w-full">
                <SelectValue placeholder="Select an account" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>{`${a.companyName} — ${a.name}`}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {selected && (
          <p className="text-sm">
            <span className="text-muted-foreground">Currently linked to: </span>
            {selected.externalPartnerKey ? (
              <span className="font-medium">{selected.externalPartnerKey}</span>
            ) : selected.partnerLinkPending ? (
              <span className="text-muted-foreground italic">
                nothing yet — a link is awaiting your confirmation above
              </span>
            ) : (
              <span className="text-muted-foreground italic">not linked yet</span>
            )}
          </p>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="pa-partner">Assign an unclaimed partner</Label>
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
              <SelectTrigger id="pa-partner" className="w-full">
                <SelectValue placeholder="Select a partner" />
              </SelectTrigger>
              <SelectContent>
                {list.partners.map((p) => (
                  <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <div className="flex gap-2 pt-1">
          <Button type="button" onClick={() => void save(partnerName)} disabled={!canAssign}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Assign
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void save(null)}
            disabled={!selected?.externalPartnerKey || saving}
          >
            Clear link
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
