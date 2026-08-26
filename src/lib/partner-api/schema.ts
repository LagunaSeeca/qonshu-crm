import { z } from "zod";

// Zod schemas mirroring the Django Partner API response shapes EXACTLY. The client
// validates every response against these, and the inferred types below are the
// single source of truth for callers.

export const PaymentMethodSchema = z.enum(["CARD", "MANUAL", "CASH"]);
export const PaymentCategorySchema = z.enum([
  "APARTMENT",
  "PARKING",
  "PROPERTY",
  "OFFICE",
  "UTILITY",
]);

export const PartnerPaymentSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  user_name: z.string(),
  date: z.string(),
  amount: z.number(),
  method: PaymentMethodSchema,
  category: PaymentCategorySchema,
});

export const PartnerStatsResponseSchema = z.object({
  partner: z.string(),
  date_from: z.string(),
  date_to: z.string(),
  total_users: z.number(),
  active_users: z.number(),
  engaged_users: z.number(),
  total_debt: z.number(),
  total_installations: z.number(),
  ios_installations: z.number(),
  android_installations: z.number(),
  logged_in_users: z.number(),
  total_payments_count: z.number(),
  total_payments_amount: z.number(),
  amount_by_card: z.number(),
  amount_by_manual: z.number(),
  amount_by_cash: z.number(),
  utility_payments_count: z.number(),
  utility_payments_amount: z.number(),
  apartment_payments_amount: z.number(),
  parking_payments_amount: z.number(),
  property_payments_amount: z.number(),
  office_payments_amount: z.number(),
  payments: z.array(PartnerPaymentSchema),
  payments_page: z.number(),
  payments_page_count: z.number(),
  payments_total_count: z.number(),
});

// Fields shared by every "unit" (apartment / parking / property / office).
const unitBase = {
  id: z.number(),
  owner_id: z.number().nullable(),
  owner_name: z.string().nullable(),
  owner_mobile: z.string().nullable(),
  debt: z.number(),
  balance: z.number(),
  net: z.number(),
};

export const ApartmentSchema = z.object({ ...unitBase, apartment_number: z.string() });
export const ParkingSchema = z.object({ ...unitBase, parking_number: z.string() });
export const PropertySchema = z.object({ ...unitBase, property_number: z.string(), type: z.string() });
export const OfficeSchema = z.object({ ...unitBase, office_number: z.string() });

export const BlockSchema = z.object({
  id: z.number(),
  name: z.string(),
  apartments: z.array(ApartmentSchema),
});

export const BuildingSchema = z.object({
  id: z.number(),
  name: z.string(),
  blocks: z.array(BlockSchema),
  parkings: z.array(ParkingSchema),
  properties: z.array(PropertySchema),
  offices: z.array(OfficeSchema),
});

export const PartnerObjectsResponseSchema = z.object({
  partner: z.string(),
  complex_type: z.enum(["RESIDENTIAL", "COMMERCIAL"]),
  buildings: z.array(BuildingSchema),
});

export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;
export type PaymentCategory = z.infer<typeof PaymentCategorySchema>;
export type PartnerPayment = z.infer<typeof PartnerPaymentSchema>;
export type PartnerStatsResponse = z.infer<typeof PartnerStatsResponseSchema>;

export type Apartment = z.infer<typeof ApartmentSchema>;
export type Parking = z.infer<typeof ParkingSchema>;
export type Property = z.infer<typeof PropertySchema>;
export type Office = z.infer<typeof OfficeSchema>;
export type Block = z.infer<typeof BlockSchema>;
export type Building = z.infer<typeof BuildingSchema>;
export type PartnerObjectsResponse = z.infer<typeof PartnerObjectsResponseSchema>;
