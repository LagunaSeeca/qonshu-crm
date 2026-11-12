import { describe, it, expect } from "vitest";
import { formatMoney } from "./money";

describe("formatMoney", () => {
  it("formats integers with no decimals by default", () => {
    expect(formatMoney(1234)).toBe("₼1,234");
  });
  it("formats 2 decimals when asked", () => {
    expect(formatMoney(1234.5, { decimals: 2 })).toBe("₼1,234.50");
    expect(formatMoney(0.4, { decimals: 2 })).toBe("₼0.40");
  });
  it("formats zero", () => {
    expect(formatMoney(0)).toBe("₼0");
    expect(formatMoney(0, { decimals: 2 })).toBe("₼0.00");
  });
  it("formats negatives", () => {
    expect(formatMoney(-250)).toBe("-₼250");
    expect(formatMoney(-12.5, { decimals: 2 })).toBe("-₼12.50");
  });
  it("formats large values with thousands separators", () => {
    expect(formatMoney(1234567890)).toBe("₼1,234,567,890");
  });
});
