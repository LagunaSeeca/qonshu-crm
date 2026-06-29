"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UserPlus, Loader2 } from "lucide-react";

type Row = { id: string; email: string; name: string; role: string; status: string };

function roleBadge(role: string) {
  if (role === "COMPANY_ADMIN") return <Badge variant="default">{role}</Badge>;
  return <Badge variant="secondary">{role}</Badge>;
}

function statusBadge(status: string) {
  if (status === "ACTIVE") return <Badge className="bg-success/10 text-success border-success/20" variant="outline">Active</Badge>;
  return <Badge variant="outline" className="text-muted-foreground">Inactive</Badge>;
}

export function UserAdmin({ initial }: { initial: Row[] }) {
  const [rows, setRows] = useState(initial);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("MEMBER");
  const [inviting, setInviting] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);

  async function invite() {
    setInviting(true);
    try {
      const r = await fetch("/api/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, role }),
      });
      if (r.ok) {
        setEmail("");
        setRole("MEMBER");
        setOpen(false);
        toast.success("Invite sent — check server console for link");
      } else {
        toast.error(r.status === 403 ? "Invite failed (forbidden)" : "Invite failed");
      }
    } finally {
      setInviting(false);
    }
  }

  async function toggle(id: string, status: string) {
    const next = status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    setToggling(id);
    try {
      const r = await fetch(`/api/users/${id}/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (r.ok) {
        setRows((rs) => rs.map((x) => (x.id === id ? { ...x, status: next } : x)));
        toast.success(`User ${next === "ACTIVE" ? "activated" : "deactivated"}`);
      } else {
        toast.error(r.status === 403 ? "Status change failed (forbidden)" : "Status change failed");
      }
    } finally {
      setToggling(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Users</h1>
          <p className="text-sm text-muted-foreground mt-1">Manage team members and their access</p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <UserPlus className="mr-2 h-4 w-4" />
          Invite user
        </Button>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-[120px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                  No users yet
                </TableCell>
              </TableRow>
            )}
            {rows.map((u) => (
              <TableRow key={u.id}>
                <TableCell className="font-medium">{u.name || "—"}</TableCell>
                <TableCell className="text-muted-foreground">{u.email}</TableCell>
                <TableCell>{roleBadge(u.role)}</TableCell>
                <TableCell>{statusBadge(u.status)}</TableCell>
                <TableCell>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={toggling === u.id}
                    onClick={() => toggle(u.id, u.status)}
                  >
                    {toggling === u.id && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                    {u.status === "ACTIVE" ? "Deactivate" : "Activate"}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Invite user</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="invite-email">Email address <span aria-hidden="true">*</span></Label>
              <Input
                id="invite-email"
                type="email"
                placeholder="colleague@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="invite-role">Role</Label>
              <Select value={role} onValueChange={(v) => setRole(v ?? "MEMBER")}>
                <SelectTrigger id="invite-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MEMBER">Member</SelectItem>
                  <SelectItem value="COMPANY_ADMIN">Company Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={invite} disabled={inviting || !email}>
              {inviting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Send invite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
