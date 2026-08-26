// Client-safe constants for the 5 analytics categories (APARTMENT/PARKING/PROPERTY/OFFICE/UTILITY).
// Shared between the account-level Analytics tab (Analytics.tsx) and the company-wide
// AnalyticsView so labels, order, and colors never drift between the two. No server imports —
// this file must stay safe to import from client components.

export const CATEGORY_LABELS: Record<string, string> = {
  APARTMENT: "Apartment",
  PARKING: "Parking",
  PROPERTY: "Property",
  OFFICE: "Office",
  UTILITY: "Utility",
};

export const CATEGORY_ORDER = ["APARTMENT", "PARKING", "PROPERTY", "OFFICE", "UTILITY"];

// Fixed categorical order, colorblind-safe validated (light: 600 steps; dark: violet/rose steps
// down to 500 to stay in the dark lightness band). Slots are assigned by position, never by
// value/rank, so the same key always wears the same hue across bars, dots, and badges. Also
// reused positionally for payment-method colors (CARD/MANUAL/CASH map to the first 3 slots) —
// each consuming file keeps its own METHOD_LABELS/METHOD_ORDER since methods aren't categories.
export const CATEGORY_COLORS = [
  {
    dot: "bg-sky-600",
    bar: "bg-sky-600",
    badge: "text-sky-700 border-sky-300 bg-sky-50 dark:text-sky-400 dark:border-sky-700 dark:bg-sky-950",
  },
  {
    dot: "bg-violet-600 dark:bg-violet-500",
    bar: "bg-violet-600 dark:bg-violet-500",
    badge: "text-violet-700 border-violet-300 bg-violet-50 dark:text-violet-400 dark:border-violet-700 dark:bg-violet-950",
  },
  {
    dot: "bg-amber-600",
    bar: "bg-amber-600",
    badge: "text-amber-700 border-amber-300 bg-amber-50 dark:text-amber-400 dark:border-amber-700 dark:bg-amber-950",
  },
  {
    dot: "bg-emerald-600",
    bar: "bg-emerald-600",
    badge: "text-emerald-700 border-emerald-300 bg-emerald-50 dark:text-emerald-400 dark:border-emerald-700 dark:bg-emerald-950",
  },
  {
    dot: "bg-rose-600 dark:bg-rose-500",
    bar: "bg-rose-600 dark:bg-rose-500",
    badge: "text-rose-700 border-rose-300 bg-rose-50 dark:text-rose-400 dark:border-rose-700 dark:bg-rose-950",
  },
];
