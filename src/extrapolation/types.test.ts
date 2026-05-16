import { describe, expect, it } from "vitest";
import {
  directionForKind,
  ExtrapolationNodePatchSchema,
  ExtrapolationNodeSeedSchema,
} from "./types.js";

describe("extrapolation types", () => {
  it("maps each kind back to its direction", () => {
    expect(directionForKind("forward_branch")).toBe("forward");
    expect(directionForKind("dependency")).toBe("forward");
    expect(directionForKind("purpose")).toBe("backward");
    expect(directionForKind("stakeholder")).toBe("backward");
    expect(directionForKind("gap")).toBe("lateral");
    expect(directionForKind("invalidator")).toBe("lateral");
  });

  it("rejects kind/direction mismatches at the seed boundary", () => {
    const ok = ExtrapolationNodeSeedSchema.safeParse({
      direction: "backward",
      kind: "purpose",
      content: "serve the customer's renewal",
    });
    expect(ok.success).toBe(true);

    const bad = ExtrapolationNodeSeedSchema.safeParse({
      direction: "forward",
      kind: "purpose",
      content: "x",
    });
    expect(bad.success).toBe(false);
  });

  it("requires at least one mutated field in a node patch", () => {
    expect(ExtrapolationNodePatchSchema.safeParse({}).success).toBe(false);
    expect(
      ExtrapolationNodePatchSchema.safeParse({ status: "resolved", resolution: "found" }).success,
    ).toBe(true);
  });

  it("bounds confidence and relevance to the unit interval", () => {
    expect(ExtrapolationNodePatchSchema.safeParse({ confidence: 1.5 }).success).toBe(false);
    expect(ExtrapolationNodePatchSchema.safeParse({ relevance: -0.1 }).success).toBe(false);
  });
});
