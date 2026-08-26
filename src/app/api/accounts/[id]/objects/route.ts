import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { getAccount } from "@/lib/tenant/accounts";
import { errorResponse, UnauthorizedError } from "@/lib/http";
import { decryptSecret } from "@/lib/crypto/secret";
import { fetchPartnerObjects } from "@/lib/partner-api/client";
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

// LIVE, read-only view of a partner complex's physical structure. Fetches straight from
// the external Partner API on every request and normalizes the mixed tree for the UI —
// nothing is persisted or cached (cookie-based auth already forces a dynamic render).
export const dynamic = "force-dynamic";

// ---- Normalized response shape (single source of truth for the Objects tab) ----

// Every unit (apartment / parking / property / office) collapses to this flat shape.
// `net` is always recomputed here — the upstream `net` field is intentionally ignored.
type NormalizedUnit = {
  id: number;
  number: string;
  ownerId: number | null;
  ownerName: string | null;
  ownerMobile: string | null;
  debt: number;
  balance: number;
  net: number;
};

// Properties carry an extra free-text `type` (e.g. "shop", "storage").
type NormalizedProperty = NormalizedUnit & { type: string };

type NormalizedBlock = {
  id: number;
  name: string;
  apartments: NormalizedUnit[];
};

type NormalizedBuilding = {
  id: number;
  name: string;
  blocks: NormalizedBlock[];
  // Flat, directly on the building — NOT nested under blocks.
  parkings: NormalizedUnit[];
  properties: NormalizedProperty[];
  offices: NormalizedUnit[];
};

type ObjectsPayload = {
  status: "ok";
  partner: string;
  complexType: PartnerObjectsResponse["complex_type"];
  buildings: NormalizedBuilding[];
};

// Structural subset shared by every unit variant, so one mapper serves them all.
type UnitBase = Pick<
  Apartment,
  "id" | "owner_id" | "owner_name" | "owner_mobile" | "debt" | "balance"
>;

function toUnit(u: UnitBase, number: string): NormalizedUnit {
  return {
    id: u.id,
    number,
    // Vacant units arrive with owner_* = null; pass them straight through.
    ownerId: u.owner_id,
    ownerName: u.owner_name,
    ownerMobile: u.owner_mobile,
    debt: u.debt,
    balance: u.balance,
    // Defensively recomputed — never trust the upstream `net`.
    net: u.balance - u.debt,
  };
}

function toProperty(p: Property): NormalizedProperty {
  return { ...toUnit(p, p.property_number), type: p.type };
}

function toBlock(b: Block): NormalizedBlock {
  return {
    id: b.id,
    name: b.name,
    apartments: b.apartments.map((a: Apartment) => toUnit(a, a.apartment_number)),
  };
}

function toBuilding(b: Building): NormalizedBuilding {
  return {
    id: b.id,
    name: b.name,
    blocks: b.blocks.map(toBlock),
    parkings: b.parkings.map((p: Parking) => toUnit(p, p.parking_number)),
    properties: b.properties.map(toProperty),
    offices: b.offices.map((o: Office) => toUnit(o, o.office_number)),
  };
}

function normalize(res: PartnerObjectsResponse): ObjectsPayload {
  return {
    status: "ok",
    partner: res.partner,
    complexType: res.complex_type,
    buildings: res.buildings.map(toBuilding),
  };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();

    // Same-company chokepoint: cross-tenant / partner-scope violations resolve to null → 404.
    const account = await getAccount(prisma, user, (await params).id);
    if (!account) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const baseUrl = process.env.PARTNER_API_BASE_URL?.trim();
    // If the integration isn't fully wired up, report it as a typed state — never call out.
    if (!account.externalApiKeyEnc || !account.externalPartnerKey || !baseUrl) {
      return NextResponse.json({ status: "not_configured" }, { status: 200 });
    }

    let objects: PartnerObjectsResponse;
    try {
      // decryptSecret lives inside this try too: a decrypt failure (tampered ciphertext /
      // missing PARTNER_API_KEY_SECRET) is an upstream-integration failure just like the
      // network calls below, and must map to the same typed status — never a raw 500.
      const apiKey = decryptSecret(account.externalApiKeyEnc);
      objects = await fetchPartnerObjects({
        baseUrl,
        apiKey,
        partner: account.externalPartnerKey,
      });
    } catch (e) {
      // Map each upstream failure to a distinct, typed status the Objects tab can branch on.
      if (e instanceof InvalidApiKeyError)
        return NextResponse.json({ status: "invalid_api_key" }, { status: 502 });
      if (e instanceof UnknownPartnerError)
        return NextResponse.json({ status: "unknown_partner" }, { status: 502 });
      if (e instanceof PartnerApiUnavailableError)
        return NextResponse.json({ status: "partner_api_unavailable" }, { status: 503 });
      // Anything else — including a zod ValidationError from upstream response-shape drift, or a
      // decrypt failure above — collapses to the same typed "unavailable" state. Never echo raw
      // error text (it may carry field paths, the URL, or secret material) back to the client.
      return NextResponse.json({ status: "partner_api_unavailable" }, { status: 503 });
    }

    return NextResponse.json(normalize(objects), { status: 200 });
  } catch (e) {
    return errorResponse(e);
  }
}
