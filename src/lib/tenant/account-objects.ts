import { prisma } from "@/db/client";
import { can, type SessionUser } from "@/lib/auth/guards";
import { getAccount } from "./accounts";
import { fetchPartnerObjects } from "@/lib/partner-api/client";
import { resolvePartnerCredentials, type PartnerCredentials } from "@/lib/partner-api/credentials";
import {
  InvalidApiKeyError,
  UnknownPartnerError,
  PartnerApiUnavailableError,
} from "@/lib/partner-api/errors";
import type {
  PartnerObjectsResponse,
  Building,
  Block,
  Apartment,
  Parking,
  Property,
  Office,
} from "@/lib/partner-api/schema";

// LIVE, read-only view of a partner complex's physical structure. Fetched from the external
// Partner API on every call; nothing is persisted or cached.
//
// THE ROLE GATE LIVES HERE, not in the route: server components call this directly and pass the
// result into the client bundle, so a route-only check would still ship per-unit data to the
// browser. A role without `view_object_detail` gets the portfolio TOTALS and nothing per-unit —
// the detail is stripped before the value is returned, so it is never in any serialized payload.

// Every unit collapses to this flat shape. `net` is always recomputed — the upstream `net` is
// intentionally ignored.
export type NormalizedUnit = {
  id: number;
  number: string;
  ownerId: number | null;
  ownerName: string | null;
  ownerMobile: string | null;
  debt: number;
  balance: number;
  net: number;
};
export type NormalizedProperty = NormalizedUnit & { type: string };
export type NormalizedBlock = { id: number; name: string; apartments: NormalizedUnit[] };
export type NormalizedBuilding = {
  id: number;
  name: string;
  blocks: NormalizedBlock[];
  // Flat, directly on the building — NOT nested under blocks.
  parkings: NormalizedUnit[];
  properties: NormalizedProperty[];
  offices: NormalizedUnit[];
};

// Counts only. Deliberately NO money (debt/balance) here: those are payment detail.
export type ObjectsTotals = {
  buildings: number;
  blocks: number;
  apartments: number;
  parkings: number;
  properties: number;
  offices: number;
};

type OkBase = {
  status: "ok";
  partner: string;
  complexType: PartnerObjectsResponse["complex_type"];
  totals: ObjectsTotals;
};
export type ObjectsFull = OkBase & { detail: "full"; buildings: NormalizedBuilding[] };
// Members: totals only. No `buildings` key at all.
export type ObjectsSummary = OkBase & { detail: "summary" };

export type ObjectsResult =
  | { status: "not_found" }
  | { status: "not_configured" }
  | { status: "invalid_api_key" }
  | { status: "unknown_partner" }
  | { status: "partner_api_unavailable" }
  | ObjectsFull
  | ObjectsSummary;

type UnitBase = Pick<Apartment, "id" | "owner_id" | "owner_name" | "owner_mobile" | "debt" | "balance">;

function toUnit(u: UnitBase, number: string): NormalizedUnit {
  return {
    id: u.id,
    number,
    ownerId: u.owner_id,
    ownerName: u.owner_name,
    ownerMobile: u.owner_mobile,
    debt: u.debt,
    balance: u.balance,
    net: u.balance - u.debt,
  };
}
const toProperty = (p: Property): NormalizedProperty => ({ ...toUnit(p, p.property_number), type: p.type });
const toBlock = (b: Block): NormalizedBlock => ({
  id: b.id,
  name: b.name,
  apartments: b.apartments.map((a: Apartment) => toUnit(a, a.apartment_number)),
});
const toBuilding = (b: Building): NormalizedBuilding => ({
  id: b.id,
  name: b.name,
  blocks: b.blocks.map(toBlock),
  parkings: b.parkings.map((p: Parking) => toUnit(p, p.parking_number)),
  properties: b.properties.map(toProperty),
  offices: b.offices.map((o: Office) => toUnit(o, o.office_number)),
});

// Totals are summed over the buildings in the response — which is exactly the one account's
// partner complex the caller already passed getAccount scoping for. Never a company-wide count.
export function computeTotals(buildings: NormalizedBuilding[]): ObjectsTotals {
  const t: ObjectsTotals = { buildings: buildings.length, blocks: 0, apartments: 0, parkings: 0, properties: 0, offices: 0 };
  for (const b of buildings) {
    t.blocks += b.blocks.length;
    for (const bl of b.blocks) t.apartments += bl.apartments.length;
    t.parkings += b.parkings.length;
    t.properties += b.properties.length;
    t.offices += b.offices.length;
  }
  return t;
}

export async function getAccountObjects(user: SessionUser, accountId: string): Promise<ObjectsResult> {
  // Same-company / partner-scope chokepoint: violations resolve to null.
  const account = await getAccount(prisma, user, accountId);
  if (!account) return { status: "not_found" };

  let creds: PartnerCredentials | null;
  try {
    // A decrypt failure on a per-account override key is an upstream-integration failure and
    // maps to the same typed status as the network calls below — never a raw 500.
    creds = resolvePartnerCredentials(account);
  } catch {
    return { status: "partner_api_unavailable" };
  }
  if (!creds) return { status: "not_configured" };

  let raw: PartnerObjectsResponse;
  try {
    raw = await fetchPartnerObjects({ baseUrl: creds.baseUrl, apiKey: creds.apiKey, partner: creds.partner });
  } catch (e) {
    if (e instanceof InvalidApiKeyError) return { status: "invalid_api_key" };
    if (e instanceof UnknownPartnerError) return { status: "unknown_partner" };
    // Anything else (incl. zod drift) collapses to unavailable; never echo raw error text.
    return { status: "partner_api_unavailable" };
  }

  const buildings = raw.buildings.map(toBuilding);
  const base: OkBase = {
    status: "ok",
    partner: raw.partner,
    complexType: raw.complex_type,
    totals: computeTotals(buildings),
  };
  // Fails closed: unknown/unlisted role -> summary only.
  if (!can(user, "view_object_detail")) return { ...base, detail: "summary" };
  return { ...base, detail: "full", buildings };
}
