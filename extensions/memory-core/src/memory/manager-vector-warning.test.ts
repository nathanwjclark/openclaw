import { describe, expect, it, vi } from "vitest";
import { logMemoryVectorDegradedWrite } from "./manager-vector-warning.js";

describe("memory vector degradation warnings", () => {
  it("attributes degradation to sqlite-vec only when a loadError is present", () => {
    const warn = vi.fn();

    const shown = logMemoryVectorDegradedWrite({
      vectorEnabled: true,
      vectorReady: false,
      chunkCount: 3,
      warningShown: false,
      loadError: "extension failed to compile",
      warn,
    });

    expect(shown).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0];
    expect(message).toContain("sqlite-vec extension failed to load: extension failed to compile");
    expect(message).toContain("FTS recall still works");
  });

  it("attributes degradation to the missing provider when no loadError is captured", () => {
    const warn = vi.fn();

    const shown = logMemoryVectorDegradedWrite({
      vectorEnabled: true,
      vectorReady: false,
      chunkCount: 3,
      warningShown: false,
      // No loadError + no provider configured — this was the misdiagnosed case
      // that previously surfaced as "sqlite-vec unavailable" and led operators
      // to conclude the SQLite system as a whole was down.
      providerUnavailableReason: "no embedding provider configured",
      warn,
    });

    expect(shown).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0];
    expect(message).toContain("no embedding provider configured");
    expect(message).toContain("sqlite-vec is available but unused");
    expect(message).not.toContain("failed to load");
  });

  it("suppresses duplicate warnings for the same manager run", () => {
    const warn = vi.fn();
    const first = logMemoryVectorDegradedWrite({
      vectorEnabled: true,
      vectorReady: false,
      chunkCount: 3,
      warningShown: false,
      loadError: "load failed",
      warn,
    });
    const second = logMemoryVectorDegradedWrite({
      vectorEnabled: true,
      vectorReady: false,
      chunkCount: 2,
      warningShown: first,
      loadError: "load failed",
      warn,
    });
    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("skips the warning when vector writes are available", () => {
    const warn = vi.fn();
    const shown = logMemoryVectorDegradedWrite({
      vectorEnabled: true,
      vectorReady: true,
      chunkCount: 1,
      warningShown: false,
      warn,
    });
    expect(shown).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
