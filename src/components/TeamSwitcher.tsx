"use client";

import { usePathname, useRouter } from "next/navigation";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const TEMPLATE_VALUE = "template";

type Props = {
  teams: { id: string; name: string }[];
  /** A team id, or TEMPLATE_VALUE for the org default template. */
  value: string;
  /** Offer the "Default template" entry (settings pages only). */
  includeTemplate?: boolean;
  label?: string;
};

// SUPER_ADMIN's `?teamId=` switcher. The URL is the state, so server pages re-render for the new
// team and the choice survives a refresh.
export function TeamSwitcher({ teams, value, includeTemplate = false, label = "Team" }: Props) {
  const router = useRouter();
  const pathname = usePathname();

  const items: Record<string, string> = Object.fromEntries(teams.map((t) => [t.id, t.name]));
  if (includeTemplate) items[TEMPLATE_VALUE] = "Default template";

  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="team-switcher" className="text-sm text-muted-foreground">{label}</Label>
      <Select
        items={items}
        value={value}
        onValueChange={(v) => {
          if (v) router.push(`${pathname}?teamId=${encodeURIComponent(v)}`);
        }}
      >
        <SelectTrigger id="team-switcher" className="h-8 min-w-40 text-sm">
          <SelectValue placeholder="Select team" />
        </SelectTrigger>
        <SelectContent>
          {includeTemplate && <SelectItem value={TEMPLATE_VALUE}>Default template</SelectItem>}
          {teams.map((t) => (
            <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
