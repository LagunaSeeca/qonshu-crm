import { describe, it, expect } from "vitest";
import { errorResponse, ForbiddenError, UnauthorizedError } from "./http";

describe("errorResponse", () => {
  it("maps known errors to status codes", () => {
    expect(errorResponse(new UnauthorizedError()).status).toBe(401);
    expect(errorResponse(new ForbiddenError()).status).toBe(403);
    expect(errorResponse(new Error("boom")).status).toBe(500);
  });
});
