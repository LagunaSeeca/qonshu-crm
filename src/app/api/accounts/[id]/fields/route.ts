import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { getAccountFields, setAccountFieldValue } from "@/lib/tenant/account-fields";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    return NextResponse.json(await getAccountFields(prisma, user, (await params).id));
  } catch (e) { return errorResponse(e); }
}

const Body = z.object({ fieldDefId: z.string().min(1), value: z.string() });
async function setValue(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const d = Body.parse(await req.json());
    const value = await setAccountFieldValue(prisma, user, (await params).id, d.fieldDefId, d.value);
    return NextResponse.json(value);
  } catch (e) { return errorResponse(e); }
}

export const PUT = setValue;
export const POST = setValue;
