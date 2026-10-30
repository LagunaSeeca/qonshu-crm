"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, UsersRound, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/PageHeader";

export type TeamRow = {
  id: string;
  name: string;
  createdAt: string;
  admins: number;
  members: number;
  admin: { id: string; name: string; email: string } | null;
};

export function TeamAdmin({ initial }: { initial: TeamRow[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [creating, setCreating] = useState(false);

  function reset() {
    setName("");
    setAdminName("");
    setAdminEmail("");
    setAdminPassword("");
  }

  async function createTeam() {
    setCreating(true);
    try {
      const r = await fetch("/api/teams", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, adminName, adminEmail, adminPassword }),
      });
      if (r.ok) {
        toast.success("Team created — share the admin's email and password with them directly");
        reset();
        setOpen(false);
        router.refresh();
      } else if (r.status === 409) {
        toast.error("A team with that name, or a user with that email, already exists");
      } else if (r.status === 403) {
        toast.error("Only the owner can create teams");
      } else {
        const body = await r.json().catch(() => ({}));
        toast.error(body?.error ?? "Failed to create team");
      }
    } catch {
      toast.error("Failed to create team");
    } finally {
      setCreating(false);
    }
  }

  const valid = name.trim() && adminName.trim() && adminEmail.trim() && adminPassword.length >= 8;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Teams"
        subtitle="Each sales team has one admin, who adds the team's members"
        action={
          <Button onClick={() => setOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New team
          </Button>
        }
      />

      {initial.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center rounded-lg border border-dashed border-border">
          <UsersRound className="size-8 mb-2 opacity-40 text-muted-foreground" />
          <p className="text-muted-foreground text-sm">No teams yet</p>
          <p className="text-xs text-muted-foreground mt-1">Create a team and its admin to get started</p>
        </div>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Team</TableHead>
                <TableHead>Admin</TableHead>
                <TableHead className="text-right">Members</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {initial.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.name}</TableCell>
                  <TableCell>
                    {t.admin ? (
                      <div className="leading-tight">
                        <div>{t.admin.name}</div>
                        <div className="text-xs text-muted-foreground">{t.admin.email}</div>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">No active admin</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{t.members}</TableCell>
                  <TableCell className="text-muted-foreground">{new Date(t.createdAt).toLocaleDateString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New team</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="team-name">Team name <span aria-hidden="true">*</span></Label>
              <Input id="team-name" placeholder="e.g. Baku Sales" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <p className="text-xs text-muted-foreground">The team&apos;s admin login:</p>
            <div className="space-y-1.5">
              <Label htmlFor="team-admin-name">Admin name <span aria-hidden="true">*</span></Label>
              <Input id="team-admin-name" value={adminName} onChange={(e) => setAdminName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="team-admin-email">Admin email <span aria-hidden="true">*</span></Label>
              <Input id="team-admin-email" type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="team-admin-password">Admin password <span aria-hidden="true">*</span></Label>
              <Input
                id="team-admin-password"
                type="password"
                placeholder="Min 8 characters"
                minLength={8}
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={createTeam} disabled={creating || !valid}>
              {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create team
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
