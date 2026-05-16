import { describe, expect, it } from "vitest";
import {
  assertGraphTransition,
  assertNodeTransition,
  canTransitionGraph,
  canTransitionNode,
  ExtrapolationTransitionError,
  isTerminalGraphStatus,
  isTerminalNodeStatus,
} from "./state-machine.js";

describe("extrapolation state machine", () => {
  it("allows active to resolved or abandoned", () => {
    expect(canTransitionGraph("active", "resolved")).toBe(true);
    expect(canTransitionGraph("active", "abandoned")).toBe(true);
    expect(canTransitionGraph("active", "active")).toBe(true);
  });

  it("rejects exits from terminal graph states", () => {
    expect(canTransitionGraph("resolved", "active")).toBe(false);
    expect(canTransitionGraph("abandoned", "resolved")).toBe(false);
    expect(() => assertGraphTransition("resolved", "active")).toThrow(ExtrapolationTransitionError);
  });

  it("allows promoted nodes to resolve, invalidate, or prune", () => {
    expect(canTransitionNode("promoted", "resolved")).toBe(true);
    expect(canTransitionNode("promoted", "invalidated")).toBe(true);
    expect(canTransitionNode("promoted", "pruned")).toBe(true);
    expect(canTransitionNode("promoted", "open")).toBe(false);
  });

  it("rejects exits from terminal node states", () => {
    expect(canTransitionNode("resolved", "open")).toBe(false);
    expect(canTransitionNode("pruned", "promoted")).toBe(false);
    expect(() => assertNodeTransition("resolved", "open")).toThrow(ExtrapolationTransitionError);
  });

  it("recognizes terminal statuses", () => {
    expect(isTerminalGraphStatus("active")).toBe(false);
    expect(isTerminalGraphStatus("resolved")).toBe(true);
    expect(isTerminalGraphStatus("abandoned")).toBe(true);
    expect(isTerminalNodeStatus("open")).toBe(false);
    expect(isTerminalNodeStatus("promoted")).toBe(false);
    expect(isTerminalNodeStatus("resolved")).toBe(true);
    expect(isTerminalNodeStatus("pruned")).toBe(true);
    expect(isTerminalNodeStatus("invalidated")).toBe(true);
  });
});
