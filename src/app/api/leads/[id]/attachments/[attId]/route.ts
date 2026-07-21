import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { getAttachmentForDownload, deleteAttachment } from "@/lib/tenant/attachments";
import { errorResponse, UnauthorizedError, contentDisposition } from "@/lib/http";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; attId: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const { attId } = await params;
    const dl = await getAttachmentForDownload(prisma, user, attId);
    if (!dl) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return new NextResponse(new Uint8Array(dl.bytes), { headers: { "Content-Type": dl.att.mime, "Content-Disposition": contentDisposition(dl.att.filename) } });
  } catch (e) { return errorResponse(e); }
}
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; attId: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const { attId } = await params;
    await deleteAttachment(prisma, user, attId);
    return NextResponse.json({ ok: true });
  } catch (e) { return errorResponse(e); }
}
