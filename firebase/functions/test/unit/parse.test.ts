import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parse } from "../../src/lib/auth.js";

describe("parse (callable input)", () => {
  const Optional = z.object({ clientId: z.string().optional() });
  const Required = z.object({ sessionId: z.string() });

  it("treats a call with no data as no options", () => {
    expect(parse(Optional, null)).toEqual({});
    expect(parse(Optional, undefined)).toEqual({});
  });
  it("treats null fields as absent", () => {
    expect(parse(Optional, { clientId: null })).toEqual({});
  });
  it("still rejects missing required fields", () => {
    expect(() => parse(Required, null)).toThrow(/sessionId/);
    expect(() => parse(Required, { sessionId: null })).toThrow(/sessionId/);
  });
});
