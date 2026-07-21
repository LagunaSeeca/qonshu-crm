import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { errorResponse, ForbiddenError, UnauthorizedError, contentDisposition } from "./http";

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

describe("contentDisposition", () => {
  it("passes a plain filename through in the ASCII fallback", () => {
    const h = contentDisposition("report.pdf");
    expect(h).toContain('filename="report.pdf"');
    expect(h).toContain("filename*=UTF-8''report.pdf");
  });

  it("neutralizes quotes, backslashes and CR/LF so the header can't be broken", () => {
    const h = contentDisposition('a";\r\nSet-Cookie: x=1\\.pdf');
    expect(h).not.toMatch(/[\r\n]/);
    // no raw double-quote survives inside the fallback value
    expect(h.slice('attachment; filename="'.length).indexOf('"')).toBe(
      h.slice('attachment; filename="'.length).lastIndexOf('"')
    );
  });

  it("carries the real unicode name in filename* (percent-encoded)", () => {
    const h = contentDisposition("отчёт 2026.csv");
    expect(h).toContain(`filename*=UTF-8''${encodeURIComponent("отчёт 2026.csv")}`);
    expect(h).toMatch(/filename="_+ 2026\.csv"/); // non-ASCII → underscores in fallback
  });
});
