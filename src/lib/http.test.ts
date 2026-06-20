import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { errorResponse, ForbiddenError, UnauthorizedError } from "./http";

describe("errorResponse", () => {
  it("maps known errors to status codes", () => {
    expect(errorResponse(new UnauthorizedError()).status).toBe(401);
    expect(errorResponse(new ForbiddenError()).status).toBe(403);
    expect(errorResponse(new Error("boom")).status).toBe(500);
  });

  it("maps Prisma P2002 unique violation to 409", () => {
    const e = new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" });
    expect(errorResponse(e).status).toBe(409);
  });
});
