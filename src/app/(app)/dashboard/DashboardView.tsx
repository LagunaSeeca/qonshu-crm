"use client";
import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Users,
  Trophy,
  CalendarCheck,
  ListTodo,
  AlertTriangle,
  Building2,
  Smartphone,
  UserCheck,
  DollarSign,
  ArrowDownCircle,
  ArrowUpCircle,
  Landmark,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export type PeriodType = "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "YEARLY" | "CUSTOM";

export type DashboardStats = {
  sales: { openLeads: number; wonInPeriod: number };
  activity: { meetingsDone: number; openTasks: number; overdueTasks: number };
  partners: {
    accounts: number;
    activeAccounts: number;
    appUsers: number;
    activeAppUsers: number;
    engagedUsers: number;
    paymentsAmount: number;
  };
  finance: { collected: number; transferred: number; owed: number };
};

type Props = { initialStats: DashboardStats; initialPeriod: PeriodType };

export const PERIODS: { key: Exclude<PeriodType, "CUSTOM">; label: string }[] = [
  { key: "WEEKLY", label: "Weekly" },
  { key: "BIWEEKLY", label: "Biweekly" },
  { key: "MONTHLY", label: "Monthly" },
  { key: "YEARLY", label: "Yearly" },
];

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function KpiCard({
  label,
  value,
  icon: Icon,
  warning,
  emphasize,
  hint,
  href,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  warning?: boolean;
  emphasize?: boolean;
  hint?: string;
  href?: string;
}) {
  const card = (
    <Card
      size="sm"
      className={cn(href && "cursor-pointer transition-colors duration-150 hover:border-accent hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
        <Icon className={cn("size-4", warning ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")} />
      </CardHeader>
      <CardContent>
        <div
          className={cn(
            "font-bold tabular-nums",
            emphasize ? "text-2xl text-accent" : "text-xl",
            warning && "text-amber-600 dark:text-amber-400"
          )}
        >
          {value}
        </div>
        {hint && <p className="text-[11px] text-muted-foreground mt-1">{hint}</p>}
      </CardContent>
    </Card>
  );

  if (!href) return card;
  return (
    <Link href={href} className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {card}
    </Link>
  );
}

function KpiGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">{title}</h2>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">{children}</div>
    </section>
  );
}

export function DashboardView({ initialStats, initialPeriod }: Props) {
  const [stats, setStats] = useState<DashboardStats>(initialStats);
  const [period, setPeriod] = useState<PeriodType>(initialPeriod);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [loading, setLoading] = useState(false);

  async function load(p: PeriodType, from?: string, to?: string) {
    setLoading(true);
    try {
      const sp = new URLSearchParams({ period: p });
      if (p === "CUSTOM") {
        if (!from || !to) return;
        sp.set("from", from);
        sp.set("to", to);
      }
      const res = await fetch(`/api/dashboard?${sp}`);
      if (!res.ok) {
        toast.error("Failed to load dashboard.");
        return;
      }
      setStats(await res.json());
    } catch {
      toast.error("Failed to load dashboard.");
    } finally {
      setLoading(false);
    }
  }

  function handlePeriod(p: Exclude<PeriodType, "CUSTOM">) {
    setPeriod(p);
    setCustomFrom("");
    setCustomTo("");
    void load(p);
  }

  function handleCustomDate(which: "from" | "to", value: string) {
    const nextFrom = which === "from" ? value : customFrom;
    const nextTo = which === "to" ? value : customTo;
    if (which === "from") setCustomFrom(value);
    else setCustomTo(value);
    setPeriod("CUSTOM");
    if (nextFrom && nextTo) void load("CUSTOM", nextFrom, nextTo);
  }

  return (
    <div className="space-y-6">
      {/* Period selector */}
      <div className="flex flex-wrap items-center gap-3">
        <div role="group" aria-label="Period" className="flex items-center gap-1">
          {PERIODS.map((p) => {
            const active = period === p.key;
            return (
              <Button
                key={p.key}
                type="button"
                size="sm"
                variant={active ? "default" : "outline"}
                aria-pressed={active}
                disabled={loading}
                onClick={() => handlePeriod(p.key)}
              >
                {p.label}
              </Button>
            );
          })}
        </div>

        <div className="flex items-center gap-1.5">
          <Label htmlFor="dashFrom" className="text-xs text-muted-foreground">
            From
          </Label>
          <Input
            id="dashFrom"
            type="date"
            value={customFrom}
            onChange={(e) => handleCustomDate("from", e.target.value)}
            className="h-7 w-36 text-xs"
          />
          <Label htmlFor="dashTo" className="text-xs text-muted-foreground">
            To
          </Label>
          <Input
            id="dashTo"
            type="date"
            value={customTo}
            onChange={(e) => handleCustomDate("to", e.target.value)}
            className="h-7 w-36 text-xs"
          />
        </div>
      </div>

      <KpiGroup title="Sales">
        <KpiCard label="Open leads" value={stats.sales.openLeads.toLocaleString()} icon={Users} href="/crm/list" />
        <KpiCard label="Won this period" value={stats.sales.wonInPeriod.toLocaleString()} icon={Trophy} href="/crm/list" />
      </KpiGroup>

      <KpiGroup title="Activity">
        <KpiCard label="Meetings done" value={stats.activity.meetingsDone.toLocaleString()} icon={CalendarCheck} href="/work" />
        <KpiCard label="Open tasks" value={stats.activity.openTasks.toLocaleString()} icon={ListTodo} href="/work" />
        <KpiCard
          label="Overdue"
          value={stats.activity.overdueTasks.toLocaleString()}
          icon={AlertTriangle}
          warning
          href="/work"
        />
      </KpiGroup>

      <KpiGroup title="Partners">
        <KpiCard label="Partner accounts" value={stats.partners.accounts.toLocaleString()} icon={Building2} href="/accounts" />
        <KpiCard
          label="App users (active/total)"
          value={`${stats.partners.activeAppUsers.toLocaleString()}/${stats.partners.appUsers.toLocaleString()}`}
          icon={Smartphone}
          href="/accounts"
        />
        <KpiCard
          label="Users engaged"
          value={stats.partners.engagedUsers.toLocaleString()}
          icon={UserCheck}
          hint="Made a payment this period"
          href="/accounts"
        />
        <KpiCard label="Payments amount" value={money(stats.partners.paymentsAmount)} icon={DollarSign} href="/accounts" />
      </KpiGroup>

      <KpiGroup title="Finance">
        <KpiCard label="Collected" value={money(stats.finance.collected)} icon={ArrowDownCircle} href="/settlements" />
        <KpiCard label="Transferred" value={money(stats.finance.transferred)} icon={ArrowUpCircle} href="/settlements" />
        <KpiCard label="Owed" value={money(stats.finance.owed)} icon={Landmark} emphasize href="/settlements" />
      </KpiGroup>
    </div>
  );
}
