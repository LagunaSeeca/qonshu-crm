import { fetchPartnerStats } from "@/lib/partner-api/client";
import type { PartnerPayment, PartnerStatsResponse } from "@/lib/partner-api/schema";

// Shared LIVE pager over the Partner API's payments, used by reports (row-level detail) and the
// analytics services (distinct-payer count). Nothing fetched here is persisted.
//
// The Partner API caps page_size at 500. We cap the number of pages chased per account so a
// pathological partner can't blow up memory or hammer the upstream — 20 x 500 = up to 10,000
// payment rows per account. Aggregate totals always come from the page-1 summary (they cover the
// FULL range), so the cap only truncates row-level detail and marks the result `partial`.
export const PAGE_SIZE = 500;
export const MAX_PAGES = 20;

export type AllPayments = {
  summary: PartnerStatsResponse;
  payments: PartnerPayment[];
  partial: boolean;
};

// Page 1 (any error rejects) yields the summary plus payments_page_count; the remaining pages go
// in parallel via allSettled so one bad page degrades to "partial" instead of losing the account.
export async function fetchAllPayments(params: {
  baseUrl?: string;
  apiKey: string;
  partner: string;
  dateFrom: string;
  dateTo: string;
}): Promise<AllPayments> {
  const first = await fetchPartnerStats({ ...params, page: 1, pageSize: PAGE_SIZE });
  const totalPages = Math.max(1, Math.floor(first.payments_page_count || 1));
  const cappedPages = Math.min(totalPages, MAX_PAGES);
  const payments: PartnerPayment[] = [...first.payments];
  let partial = totalPages > MAX_PAGES;

  if (cappedPages > 1) {
    const rest = await Promise.allSettled(
      Array.from({ length: cappedPages - 1 }, (_, i) =>
        fetchPartnerStats({ ...params, page: i + 2, pageSize: PAGE_SIZE }),
      ),
    );
    for (const r of rest) {
      if (r.status === "fulfilled") payments.push(...r.value.payments);
      else partial = true;
    }
  }

  return { summary: first, payments, partial };
}

// "Online" payments are the in-app CARD ones; MANUAL (entered by staff) and CASH are not.
// Distinct by the partner's user_id. Only the COUNT ever leaves the service layer — never ids.
export function countUniquePayers(payments: PartnerPayment[]): number {
  const ids = new Set<string>();
  for (const p of payments) if (p.method === "CARD") ids.add(p.user_id);
  return ids.size;
}
