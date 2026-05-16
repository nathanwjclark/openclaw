import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema extrapolation validation", () => {
  it("accepts a bare master switch", () => {
    const result = OpenClawSchema.safeParse({ extrapolation: { enabled: true } });
    expect(result.success).toBe(true);
  });

  it("accepts the full nested shape", () => {
    const result = OpenClawSchema.safeParse({
      extrapolation: {
        enabled: true,
        perAgent: { main: { enabled: false } },
        defaults: {
          budgetNodes: 40,
          gapRelevanceThreshold: 0.7,
          gapConfidenceThreshold: 0.6,
          maxIterations: 8,
          autoFlowOnPromotions: 2,
          includeBackwardChainInTasks: true,
        },
        models: { seed: "anthropic/claude-opus-4-7", revision: "openai/gpt-5.4-mini" },
        memory: {
          crossGraphReinforcement: 3,
          confidenceFloor: 0.75,
          injectIntoSeed: true,
        },
        retention: { pruneAfter: null },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown keys at the root of extrapolation (strict)", () => {
    const result = OpenClawSchema.safeParse({
      extrapolation: { enabled: true, bogusKey: 1 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects out-of-range gap thresholds", () => {
    expect(() =>
      OpenClawSchema.parse({
        extrapolation: { defaults: { gapRelevanceThreshold: 1.5 } },
      }),
    ).toThrow();
  });
});
