import { describe, expect, it } from "vitest";
import { canonicalizeFactContent } from "./durable-facts.js";

describe("canonicalizeFactContent", () => {
  it("lowercases and collapses whitespace", () => {
    expect(canonicalizeFactContent("  User Owns   Renewals  ")).toBe("user owns renewals");
    expect(canonicalizeFactContent("Same content")).toBe(canonicalizeFactContent("same\tcontent"));
  });

  it("distinguishes materially different strings", () => {
    expect(canonicalizeFactContent("renewal pipeline")).not.toBe(
      canonicalizeFactContent("renewal pipelines"),
    );
  });
});
