import Link from "next/link";
import type { Role } from "@prisma/client";

const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/crm", label: "Sales CRM" },
  { href: "/accounts", label: "Accounts" },
  { href: "/analytics", label: "Analytics" },
];

export function Sidebar({ role }: { role: Role }) {
  return (
    <nav className="flex flex-col gap-1 p-4 w-56 border-r min-h-screen">
      <div className="font-bold mb-4">Qonshu CRM</div>
      {NAV.map((n) => (
        <Link key={n.href} href={n.href} className="px-2 py-1 rounded hover:bg-gray-100">
          {n.label}
        </Link>
      ))}
      {role === "COMPANY_ADMIN" && (
        <Link href="/users" className="px-2 py-1 rounded hover:bg-gray-100">
          Users
        </Link>
      )}
      {role === "SUPER_ADMIN" && (
        <Link href="/platform/companies" className="px-2 py-1 rounded hover:bg-gray-100">
          Companies
        </Link>
      )}
    </nav>
  );
}
