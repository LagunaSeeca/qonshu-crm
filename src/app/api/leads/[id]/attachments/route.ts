import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { addAttachment, listAttachments, FileTooLargeError } from "@/lib/tenant/attachments";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    return NextResponse.json(await listAttachments(prisma, user, (await params).id));
  } catch (e) { return errorResponse(e); }
}
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "file required" }, { status: 400 });
    const bytes = Buffer.from(await file.arrayBuffer());
    const att = await addAttachment(prisma, user, (await params).id, { filename: file.name, mime: file.type || "application/octet-stream", bytes });
    return NextResponse.json(att, { status: 201 });
  } catch (e) {
    if (e instanceof FileTooLargeError) return NextResponse.json({ error: "file_too_large" }, { status: 400 });
    return errorResponse(e);
  }
}
