import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveExtrapolationDir,
  resolveExtrapolationSqlitePath,
  resolveExtrapolationStateDir,
} from "./paths.js";

describe("extrapolation paths", () => {
  it("shards by Vitest worker id like the task registry", () => {
    const env = { VITEST: "true", VITEST_POOL_ID: "5" } as NodeJS.ProcessEnv;
    expect(resolveExtrapolationStateDir(env)).toBe(
      path.join(os.tmpdir(), "openclaw-test-state", `${process.pid}-5`),
    );
  });

  it("places the DB under <state>/extrapolation/graphs.sqlite", () => {
    const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-extrapolation-test" } as NodeJS.ProcessEnv;
    expect(resolveExtrapolationDir(env)).toBe("/tmp/openclaw-extrapolation-test/extrapolation");
    expect(resolveExtrapolationSqlitePath(env)).toBe(
      "/tmp/openclaw-extrapolation-test/extrapolation/graphs.sqlite",
    );
  });
});
