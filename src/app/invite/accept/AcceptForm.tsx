"use client";
import { useState } from "react";
import { useSearchParams } from "next/navigation";

export function AcceptForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState("");

  async function submit() {
    const r = await fetch("/api/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, name, password }),
    });
    setMsg(r.ok ? "Account created — you can sign in" : "Invalid or expired invite");
  }

  return (
    <div className="max-w-sm mx-auto mt-24 space-y-3">
      <h1 className="text-xl font-semibold">Accept invitation</h1>
      <input
        className="border p-2 rounded w-full"
        placeholder="Your name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className="border p-2 rounded w-full"
        type="password"
        placeholder="Password (min 8)"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button className="bg-black text-white p-2 rounded" onClick={submit}>
        Create account
      </button>
      {msg && <p className="text-sm">{msg}</p>}
    </div>
  );
}
