"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
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

export function AccountCreate({ members }: { members: Member[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [industry, setIndustry] = useState("");
  const [primaryContactName, setPrimaryContactName] = useState("");
  const [primaryContactEmail, setPrimaryContactEmail] = useState("");
  const [accountManagerId, setAccountManagerId] = useState(members[0]?.id ?? "");
  const [loading, setLoading] = useState(false);

  const managerItems = Object.fromEntries(members.map((m) => [m.id, m.name ?? m.email]));

  function reset() {
    setName("");
    setWebsite("");
    setIndustry("");
    setPrimaryContactName("");
    setPrimaryContactEmail("");
    setAccountManagerId(members[0]?.id ?? "");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
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
        }),
      });
      if (r.ok) {
        toast.success("Account created");
        reset();
        setOpen(false);
        router.refresh();
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
        </form>
        <DialogFooter className="pt-2">
          <Button variant="outline" type="button" onClick={() => setOpen(false)} disabled={loading}>
            Cancel
          </Button>
          <Button type="submit" form="account-create-form" disabled={loading}>
            {loading ? "Creating…" : "Create account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
