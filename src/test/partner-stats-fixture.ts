import type { PartnerStatsResponse, PartnerPayment } from "@/lib/partner-api/schema";

// Shared test fixture for the LIVE Partner API response shapes. Every field defaults to a
// harmless zero/empty value so a test only has to specify the fields it actually cares about.
// Used by every test that mocks `@/lib/partner-api/client`'s `fetchPartnerStats`.
export function makePartnerStats(overrides: Partial<PartnerStatsResponse> = {}): PartnerStatsResponse {
  return {
    partner: "test-partner",
    date_from: "2026-01-01",
    date_to: "2026-01-31",
    total_users: 0,
    active_users: 0,
    engaged_users: 0,
    total_debt: 0,
    total_installations: 0,
    ios_installations: 0,
    android_installations: 0,
    logged_in_users: 0,
    total_payments_count: 0,
    total_payments_amount: 0,
    amount_by_card: 0,
    amount_by_manual: 0,
    amount_by_cash: 0,
    utility_payments_count: 0,
    utility_payments_amount: 0,
    apartment_payments_amount: 0,
    parking_payments_amount: 0,
    property_payments_amount: 0,
    office_payments_amount: 0,
    payments: [],
    payments_page: 1,
    payments_page_count: 1,
    payments_total_count: 0,
    ...overrides,
  };
}

export function makePartnerPayment(overrides: Partial<PartnerPayment> = {}): PartnerPayment {
  return {
    id: "p1",
    user_id: "u1",
    user_name: "User",
    date: "2026-01-05",
    amount: 100,
    method: "CARD",
    category: "APARTMENT",
    ...overrides,
  };
}
