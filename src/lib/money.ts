// All amounts from the partner API are AZN. narrowSymbol renders "₼" rather than "AZN".
const FORMATTERS = {
  0: new Intl.NumberFormat("en-US", { style: "currency", currency: "AZN", currencyDisplay: "narrowSymbol", minimumFractionDigits: 0, maximumFractionDigits: 0 }),
  2: new Intl.NumberFormat("en-US", { style: "currency", currency: "AZN", currencyDisplay: "narrowSymbol", minimumFractionDigits: 2, maximumFractionDigits: 2 }),
} as const;

export function formatMoney(n: number, opts?: { decimals?: 0 | 2 }): string {
  return FORMATTERS[opts?.decimals ?? 0].format(n);
}
