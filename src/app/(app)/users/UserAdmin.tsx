"use client";
import { useState } from "react";

type Row = { id: string; email: string; name: string; role: string; status: string };

export function UserAdmin({ initial }: { initial: Row[] }) {
  const [rows, setRows] = useState(initial);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("MEMBER");

  async function invite() {
    const r = await fetch("/api/invitations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, role }),
    });
    if (r.ok) {
      setEmail("");
      alert("Invite sent (check server console for link)");
    }
  }

  async function toggle(id: string, status: string) {
    const next = status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    const r = await fetch(`/api/users/${id}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    if (r.ok) setRows((rs) => rs.map((x) => (x.id === id ? { ...x, status: next } : x)));
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Users</h1>
      <div className="flex gap-2">
        <input
          className="border p-2 rounded"
          placeholder="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <select
          className="border p-2 rounded"
          value={role}
          onChange={(e) => setRole(e.target.value)}
        >
          <option>MEMBER</option>
          <option>COMPANY_ADMIN</option>
        </select>
        <button className="bg-black text-white px-3 rounded" onClick={invite}>
          Invite
        </button>
      </div>
      <table className="w-full text-left">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.id} className="border-t">
              <td>{u.name}</td>
              <td>{u.email}</td>
              <td>{u.role}</td>
              <td>{u.status}</td>
              <td>
                <button className="text-blue-600" onClick={() => toggle(u.id, u.status)}>
                  {u.status === "ACTIVE" ? "Deactivate" : "Activate"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
