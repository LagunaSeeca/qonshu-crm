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
import { PageHeader } from "@/components/PageHeader";
import { UserPlus, Loader2 } from "lucide-react";

type Row = { id: string; email: string; name: string; role: string; status: string };
type Account = { id: string; name: string };

const ROLE_LABELS: Record<string, string> = {
  MEMBER: "Member",
  COMPANY_ADMIN: "Company Admin",
  PARTNER_VIEWER: "Partner (read-only)",
};

function roleBadge(role: string) {
  if (role === "COMPANY_ADMIN") return <Badge variant="default">{role}</Badge>;
  return <Badge variant="secondary">{role}</Badge>;
}

function statusBadge(status: string) {
  if (status === "ACTIVE") return <Badge className="bg-success/10 text-success border-success/20" variant="outline">Active</Badge>;
  return <Badge variant="outline" className="text-muted-foreground">Inactive</Badge>;
}

export function UserAdmin({ initial, accounts = [] }: { initial: Row[]; accounts?: Account[] }) {
  const [rows, setRows] = useState(initial);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("MEMBER");
  const [accountId, setAccountId] = useState("");
  const [creating, setCreating] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);

  function resetForm() {
    setName("");
    setEmail("");
    setPassword("");
    setRole("MEMBER");
    setAccountId("");
  }

  async function createUser() {
    setCreating(true);
    try {
      const body: { name: string; email: string; password: string; role: string; accountId?: string } = {
        name, email, password, role,
      };
      if (role === "PARTNER_VIEWER") body.accountId = accountId;
      const r = await fetch("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        const created = await r.json();
        setRows((rs) => [...rs, { id: created.id, email: created.email, name: created.name ?? "", role: created.role, status: created.status }]);
        resetForm();
        setOpen(false);
        toast.success("User created — share the email/password with them directly");
      } else if (r.status === 409) {
        toast.error("A user with that email already exists");
      } else if (r.status === 403) {
        toast.error("Add user failed (forbidden)");
      } else {
        const body = await r.json().catch(() => ({}));
        toast.error(body?.error ?? "Add user failed");
      }
    } finally {
      setCreating(false);
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
      <PageHeader
        title="Users"
        subtitle="Manage team members and their access"
        action={
          <Button onClick={() => setOpen(true)}>
            <UserPlus className="mr-2 h-4 w-4" />
            Add user
          </Button>
        }
      />

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
            <DialogTitle>Add user</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="new-user-name">Name <span aria-hidden="true">*</span></Label>
              <Input
                id="new-user-name"
                placeholder="Jane Doe"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-user-email">Email address <span aria-hidden="true">*</span></Label>
              <Input
                id="new-user-email"
                type="email"
                placeholder="colleague@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-user-password">Password <span aria-hidden="true">*</span></Label>
              <Input
                id="new-user-password"
                type="password"
                placeholder="Min 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-user-role">Role</Label>
              <Select
                items={ROLE_LABELS}
                value={role}
                onValueChange={(v) => {
                  setRole(v ?? "MEMBER");
                  setAccountId("");
                }}
              >
                <SelectTrigger id="new-user-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MEMBER">Member</SelectItem>
                  <SelectItem value="COMPANY_ADMIN">Company Admin</SelectItem>
                  <SelectItem value="PARTNER_VIEWER">Partner (read-only)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {role === "PARTNER_VIEWER" && (
              <div className="space-y-1.5">
                <Label htmlFor="new-user-account">Partner account <span aria-hidden="true">*</span></Label>
                {accounts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No accounts to assign yet — create one first.</p>
                ) : (
                  <Select
                    items={Object.fromEntries(accounts.map((a) => [a.id, a.name]))}
                    value={accountId}
                    onValueChange={(v) => setAccountId(v ?? "")}
                  >
                    <SelectTrigger id="new-user-account">
                      <SelectValue placeholder="Select an account" />
                    </SelectTrigger>
                    <SelectContent>
                      {accounts.map((a) => (
                        <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={createUser}
              disabled={creating || !name || !email || password.length < 8 || (role === "PARTNER_VIEWER" && !accountId)}
            >
              {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create user
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
