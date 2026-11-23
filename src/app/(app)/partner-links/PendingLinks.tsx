"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// THE CONFIRMATION QUEUE (security review finding F1).
//
// A salesperson naming a building stakes a PENDING link. It holds the building against other
// teams, and it grants nothing at all: the account's Analytics, Payments and Objects tabs read
// "not configured" until the row below is confirmed. One click each way.
//
// A team admin sees their own team's queue, the owner sees every team — the scoping is done in
// listPendingPartnerLinks, so this component renders whatever it is handed and never filters.
export type PendingLink = {
  accountId: string;
  accountName: string;
  companyName: string;
  teamName: string;
  partnerName: string;
  requestedBy: string | null;
  requestedAt: string | null;
  // The viewer proposed this one, so the two-person rule forbids them confirming it. Shown with
  // Confirm disabled and the reason spelled out, rather than hidden — a row that disappeared from
  // their own queue would read as a lost proposal.
  proposedByMe: boolean;
};

const ERROR_MESSAGES: Record<string, string> = {
  self_approval: "You proposed this link, so a colleague or the owner has to confirm it.",
  no_pending_link: "That link was already decided — refreshing.",
  partner_already_claimed: "Another account already holds that complex.",
  unknown_partner:
    "No single live complex matches that name any more. Reject it and assign the right one.",
  partner_api_unavailable: "The partner API is unreachable, so the name can't be verified.",
  forbidden: "Only a team admin or the owner can decide partner links.",
  // A cross-team account is a 404, exactly like any other out-of-scope access.
  not_found: "That account is not in your team.",
};

export function PendingLinks({ links, showTeam }: { links: PendingLink[]; showTeam: boolean }) {
  const router = useRouter();
  // Keyed by accountId so two rows can be acted on without one spinner covering both.
  const [busy, setBusy] = useState<string | null>(null);

  async function decide(link: PendingLink, action: "confirm" | "reject") {
    setBusy(link.accountId);
    try {
      const r = await fetch(`/api/accounts/${link.accountId}/partner-link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        toast.error(ERROR_MESSAGES[body?.error] ?? "Failed to decide the partner link");
        // A decision taken elsewhere leaves this list stale; re-read it either way.
        if (body?.error === "no_pending_link") router.refresh();
        return;
      }
      const body = await r.json().catch(() => ({}));
      toast.success(
        action === "confirm"
          ? `Confirmed — "${link.accountName}" now reads ${body?.externalPartnerKey ?? link.partnerName}`
          : `Rejected — "${link.partnerName}" is free again`,
      );
      router.refresh();
    } catch {
      toast.error("Failed to decide the partner link");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="w-full max-w-lg shadow-sm">
      <CardHeader className="pb-4">
        <CardTitle>Awaiting your confirmation</CardTitle>
        <CardDescription>
          Naming a building reserves it, but reads nothing. Confirming is what lets the account
          see that complex&apos;s payments, debt and unit owners — so only confirm buildings
          Qonshu actually has a contract with. You cannot confirm a link you proposed yourself.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {links.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing waiting.</p>
        ) : (
          links.map((link) => (
            <div
              key={link.accountId}
              className="rounded-lg border border-input bg-muted/40 px-3 py-2.5 space-y-2"
            >
              <div className="space-y-0.5">
                <p className="text-sm font-medium">{link.accountName}</p>
                {showTeam && (
                  <p className="text-xs text-muted-foreground">
                    {link.companyName} — {link.teamName}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Proposed complex: <span className="font-medium text-foreground">{link.partnerName}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  Requested by {link.requestedBy ?? "unknown"}
                  {link.requestedAt ? ` on ${new Date(link.requestedAt).toLocaleDateString()}` : ""}
                </p>
              </div>
              {link.proposedByMe && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  You proposed this one — a colleague or the owner has to confirm it.
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void decide(link, "confirm")}
                  disabled={busy !== null || link.proposedByMe}
                >
                  {busy === link.accountId && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Confirm
                </Button>
                {/* Reject stays enabled for your own proposal: the two-person rule exists to stop
                    someone GRANTING themselves a complex, and refusing never grants anything —
                    blocking it would only trap a mistyped building name in the queue. */}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void decide(link, "reject")}
                  disabled={busy !== null}
                >
                  Reject
                </Button>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
