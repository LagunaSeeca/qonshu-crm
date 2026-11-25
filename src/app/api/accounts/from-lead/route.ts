import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { convertLeadToAccount, startTrialFromLead } from "@/lib/tenant/lead-conversion";
import { InvalidTrialError } from "@/lib/tenant/accounts";
import { maskAccount } from "@/lib/tenant/account-dto";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const Body = z.object({
  leadId: z.string().min(1),
  // PRESENT = "start a 2-3 month TRIAL on this building", which is a different operation from
  // converting a won lead: it produces a DEMO account (live statistics, no signed contract) and
  // leaves the lead where it is in the pipeline. ABSENT = the ordinary Won conversion, which also
  // ACTIVATES an account that is already on trial.
  //
  // `endsAt` is required because a trial with no end is not a trial; `startsAt` defaults to today
  // in the service. ISO strings in, Dates out — the service layer takes Dates only.
  trial: z.object({ startsAt: z.coerce.date().optional(), endsAt: z.coerce.date() }).optional(),
});
export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    // Creating an account is admin/member work — same gate as POST /api/accounts. Without this
    // a PARTNER_VIEWER could mint accounts in the tenant off any lead id it could name.
    assertRole(user, ["COMPANY_ADMIN", "MEMBER"]);
    const { leadId, trial } = Body.parse(await req.json());
    // Idempotent: an already-converted lead (e.g. auto-converted on the move to Won) returns
    // its existing account as 200 instead of erroring, so the button always lands somewhere.
    const { account, created } = trial
      ? await startTrialFromLead(prisma, user, leadId, {
          trialStartsAt: trial.startsAt, trialEndsAt: trial.endsAt,
        })
      : await convertLeadToAccount(prisma, user, leadId);
    // maskAccount is NOT optional on the created===false branch: that returns a pre-existing row
    // which is exactly the one that could still carry a dormant externalApiKeyEnc override.
    return NextResponse.json(maskAccount(account, user), { status: created ? 201 : 200 });
  } catch (e) {
    // A trial asked for on a won/lost lead, or with a backwards window, is a 400 the caller can
    // correct — not a 500.
    if (e instanceof InvalidTrialError)
      return NextResponse.json({ error: "invalid_trial", message: e.message }, { status: 400 });
    return errorResponse(e);
  }
}
