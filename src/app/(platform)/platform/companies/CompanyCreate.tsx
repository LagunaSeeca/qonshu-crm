"use client";
import { useState } from "react";

export function CompanyCreate() {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [msg, setMsg] = useState("");

  async function submit() {
    const r = await fetch("/api/platform/companies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, slug, adminEmail }),
    });
    setMsg(r.ok ? "Company created — admin invite logged to server console" : "Error");
  }

  return (
    <div className="space-y-3 max-w-sm">
      <h1 className="text-2xl font-semibold">New Company</h1>
      <input
        className="border p-2 rounded w-full"
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className="border p-2 rounded w-full"
        placeholder="slug"
        value={slug}
        onChange={(e) => setSlug(e.target.value)}
      />
      <input
        className="border p-2 rounded w-full"
        placeholder="Admin email"
        value={adminEmail}
        onChange={(e) => setAdminEmail(e.target.value)}
      />
      <button className="bg-black text-white p-2 rounded" onClick={submit}>
        Create
      </button>
      {msg && <p className="text-sm">{msg}</p>}
    </div>
  );
}
