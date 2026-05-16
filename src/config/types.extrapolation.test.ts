import { describe, expect, it } from "vitest";
import { resolveExtrapolationEnabled } from "./types.extrapolation.js";

describe("resolveExtrapolationEnabled", () => {
  it("is disabled when config is missing", () => {
    expect(resolveExtrapolationEnabled(undefined, "agent-a")).toBe(false);
  });

  it("respects the master switch", () => {
    expect(resolveExtrapolationEnabled({ enabled: false }, "agent-a")).toBe(false);
    expect(resolveExtrapolationEnabled({ enabled: true }, "agent-a")).toBe(true);
  });

  it("lets a per-agent override take precedence", () => {
    expect(
      resolveExtrapolationEnabled(
        { enabled: false, perAgent: { "agent-a": { enabled: true } } },
        "agent-a",
      ),
    ).toBe(true);
    expect(
      resolveExtrapolationEnabled(
        { enabled: true, perAgent: { "agent-b": { enabled: false } } },
        "agent-b",
      ),
    ).toBe(false);
    expect(
      resolveExtrapolationEnabled({ enabled: true, perAgent: { "agent-b": {} } }, "agent-b"),
    ).toBe(true);
  });
});
