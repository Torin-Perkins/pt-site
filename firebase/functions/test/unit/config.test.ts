import { describe, expect, it } from "vitest";
import { normalizeBaseUrl } from "../../src/config.js";

describe("normalizeBaseUrl", () => {
  it.each([
    ["https://www.torofitness.com", "https://www.torofitness.com"],
    ["www.torofitness.com", "https://www.torofitness.com"],
    ["torofitness.com/", "https://torofitness.com"],
    ["  https://www.torofitness.com//  ", "https://www.torofitness.com"],
    ['"www.torofitness.com"', "https://www.torofitness.com"],
    ["//www.torofitness.com", "https://www.torofitness.com"],
    ["http://localhost:5173", "http://localhost:5173"],
    ["HTTPS://Example.com", "HTTPS://Example.com"],
  ])("%s → %s", (raw, expected) => {
    expect(normalizeBaseUrl(raw)).toBe(expected);
    expect(() => new URL(`${normalizeBaseUrl(raw)}/portal/billing?checkout=success`)).not.toThrow();
  });
});
