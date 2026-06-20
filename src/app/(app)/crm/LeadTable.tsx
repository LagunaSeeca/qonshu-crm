import Link from "next/link";

export type LeadRow = {
  id: string;
  title: string;
  contactName: string;
  stageName: string;
  value: number;
  priority: string;
  ownerName: string;
};

export function LeadTable({ rows }: { rows: LeadRow[] }) {
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b">
          <th className="py-2">Title</th>
          <th>Contact</th>
          <th>Stage</th>
          <th>Owner</th>
          <th>Priority</th>
          <th className="text-right">Value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="border-b hover:bg-gray-50">
            <td className="py-2">
              <Link href={`/crm/${r.id}`} className="text-blue-600">{r.title}</Link>
            </td>
            <td>{r.contactName}</td>
            <td>{r.stageName}</td>
            <td>{r.ownerName}</td>
            <td>{r.priority}</td>
            <td className="text-right">{r.value.toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
