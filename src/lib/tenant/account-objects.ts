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
//
// THERE ARE NOW TWO GATES, and they cut the payload in different directions.
//
//   view_object_detail  — may you see the UNITS at all (and therefore the owner names and phones)?
//                         No  -> ObjectsSummary: counts only, no `buildings` key whatsoever.
//   view_financials     — may you see the MONEY on those units?
//                         No  -> the units come back with `debt`/`balance`/`net` REMOVED.
//
// ONBOARDING holds the first and not the second, which is the entire shape of the role: the
// activation checklist is "text the residents, add them to WhatsApp, train the manager", so the
// unit list and the owners' names and phone numbers are the job — and what each flat owes Qonshu
// is categorically not.
//
// THE KEYS ARE OMITTED, NOT ZEROED. A `debt: 0` is a statement that the flat owes nothing, which
// would be a fabricated financial fact; this codebase has a standing rule against inventing a 0
// where it has no value (see settlements.ts, which drops `collected`/`remaining` outright rather
// than defaulting a failed fetch to 0). An absent key also fails CLOSED in any consumer: reading
// `u.debt` yields undefined and formats as nothing, rather than as a confident zero.

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

// The three money keys, named once so the money-free mirrors below are derived from the real shape
// and the two can never drift apart.
export type UnitMoney = Pick<NormalizedUnit, "debt" | "balance" | "net">;
const MONEY_KEYS = ["debt", "balance", "net"] as const satisfies readonly (keyof UnitMoney)[];
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

// Money-free mirrors of the four shapes above, for a caller that holds `view_object_detail` but
// NOT `view_financials`. Built with Omit over UnitMoney rather than written out, so adding a money
// field to NormalizedUnit automatically removes it here too.
export type NormalizedUnitNoMoney = Omit<NormalizedUnit, keyof UnitMoney>;
export type NormalizedPropertyNoMoney = Omit<NormalizedProperty, keyof UnitMoney>;
export type NormalizedBlockNoMoney = { id: number; name: string; apartments: NormalizedUnitNoMoney[] };
export type NormalizedBuildingNoMoney = {
  id: number;
  name: string;
  blocks: NormalizedBlockNoMoney[];
  parkings: NormalizedUnitNoMoney[];
  properties: NormalizedPropertyNoMoney[];
  offices: NormalizedUnitNoMoney[];
};

// Counts only. Deliberately NO money (debt/balance) here: those are payment detail.
//
// Re-confirmed for the ONBOARDING work: there is no monetary field in this type, so there is
// nothing for the view_financials strip to remove from `totals` — the counts stay whole for every
// role that gets this far. If a money field is ever ADDED here, it must be stripped alongside the
// per-unit keys (see stripMoney below), not left because `totals` "is just totals".
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
// ONBOARDING: the full unit tree, with the three money keys gone from every unit.
//
// DELIBERATELY NOT A MEMBER OF `ObjectsResult`. Adding a second `detail: "full"` variant to that
// union would widen `state.buildings` in the existing Objects.tsx to
// `NormalizedBuilding[] | NormalizedBuildingNoMoney[]` and break its `formatMoney(u.debt)` calls at
// compile time — in a component this change is not allowed to touch, and whose money columns a
// later UI task is going to hide for this role anyway. So `ObjectsResult` keeps its exact current
// shape and getAccountObjects' return type is widened instead; the API serializes structurally
// either way. When the UI task lands, fold this into ObjectsResult and narrow on the money keys.
export type ObjectsFullNoMoney = OkBase & { detail: "full"; buildings: NormalizedBuildingNoMoney[] };

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

// Remove the money keys from one unit. `delete` on a shallow copy, so the keys are genuinely ABSENT
// from the object — not present-and-undefined, which `JSON.stringify` would also drop but which a
// `"debt" in u` check would read as present.
function stripUnitMoney<T extends UnitMoney>(u: T): Omit<T, keyof UnitMoney> {
  const copy = { ...u } as Record<string, unknown>;
  for (const k of MONEY_KEYS) delete copy[k];
  return copy as Omit<T, keyof UnitMoney>;
}

// Walk the whole tree. Every unit-bearing collection must be covered: apartments (nested under
// blocks), and the three flat ones hanging off the building. Missing one would leave a building's
// parking debts in a payload the rest of which was carefully cleaned.
function stripMoney(buildings: NormalizedBuilding[]): NormalizedBuildingNoMoney[] {
  return buildings.map((b) => ({
    id: b.id,
    name: b.name,
    blocks: b.blocks.map((bl) => ({
      id: bl.id,
      name: bl.name,
      apartments: bl.apartments.map(stripUnitMoney),
    })),
    parkings: b.parkings.map(stripUnitMoney),
    properties: b.properties.map(stripUnitMoney),
    offices: b.offices.map(stripUnitMoney),
  }));
}

export async function getAccountObjects(
  user: SessionUser, accountId: string,
): Promise<ObjectsResult | ObjectsFullNoMoney> {
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
  // The second gate. A role that may see the units but not the money (ONBOARDING) gets the whole
  // tree with debt/balance/net removed from every unit — the resident contact details it needs,
  // none of the financial position it does not. A MEMBER never reaches this branch at all (they
  // lack view_object_detail and got the summary above), so nothing about a member changes here.
  if (!can(user, "view_financials")) {
    return { ...base, detail: "full", buildings: stripMoney(buildings) };
  }
  return { ...base, detail: "full", buildings };
}
