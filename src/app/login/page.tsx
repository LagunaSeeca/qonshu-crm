"use client";
import { useState } from "react";
import { signIn } from "next-auth/react";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = await signIn("credentials", { email, password, redirect: false });
    if (r?.error) setErr("Invalid credentials");
    else window.location.href = "/dashboard";
  }

  return (
    <form onSubmit={submit} className="max-w-sm mx-auto mt-24 flex flex-col gap-3">
      <h1 className="text-xl font-semibold">Sign in</h1>
      <input
        className="border p-2 rounded"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <input
        className="border p-2 rounded"
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {err && <p className="text-red-600 text-sm">{err}</p>}
      <button className="bg-black text-white p-2 rounded">Sign in</button>
    </form>
  );
}
