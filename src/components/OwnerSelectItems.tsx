import { SelectGroup, SelectItem, SelectLabel } from "@/components/ui/select";

export type OwnerOptionLike = { id: string; name: string; teamId: string | null; teamName: string | null };

// SelectContent children for an owner picker. With `grouped` (the SUPER_ADMIN, who sees several
// teams) options are grouped under their team name; otherwise it is a flat list.
export function OwnerSelectItems({ owners, grouped }: { owners: OwnerOptionLike[]; grouped: boolean }) {
  if (!grouped) {
    return <>{owners.map((o) => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}</>;
  }
  const groups = new Map<string, OwnerOptionLike[]>();
  for (const o of owners) {
    const key = o.teamName ?? "No team";
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  return (
    <>
      {[...groups.entries()].map(([team, list]) => (
        <SelectGroup key={team}>
          <SelectLabel>{team}</SelectLabel>
          {list.map((o) => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}
        </SelectGroup>
      ))}
    </>
  );
}
