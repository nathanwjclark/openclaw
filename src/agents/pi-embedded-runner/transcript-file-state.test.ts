import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTranscriptFileState } from "./transcript-file-state.js";

const roots: string[] = [];

async function makeRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("readTranscriptFileState", () => {
  it("skips malformed session entries without moving the active leaf", async () => {
    const root = await makeRoot("openclaw-transcript-state-malformed-");
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "session-1",
          timestamp: "2026-05-16T00:00:00.000Z",
          cwd: root,
        }),
        JSON.stringify({
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: "2026-05-16T00:00:01.000Z",
          message: { role: "user", content: "hello" },
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-1",
          parentId: "user-1",
          timestamp: "2026-05-16T00:00:02.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
        }),
        JSON.stringify({
          type: "message",
          id: "bad-message",
          parentId: "assistant-1",
          timestamp: "2026-05-16T00:00:03.000Z",
          message: { content: "missing role" },
        }),
        JSON.stringify({
          type: "label",
          parentId: "bad-message",
          timestamp: "2026-05-16T00:00:04.000Z",
          targetId: "user-1",
          label: "missing id",
        }),
        JSON.stringify({
          type: "future_poison",
          id: "unknown-type",
          parentId: "assistant-1",
          timestamp: "2026-05-16T00:00:05.000Z",
        }),
        JSON.stringify({
          type: "model_change",
          id: "orphan-model-change",
          parentId: "bad-message",
          timestamp: "2026-05-16T00:00:06.000Z",
          provider: "openai",
          modelId: "gpt-5.5",
        }),
      ].join("\n"),
      "utf-8",
    );

    const state = await readTranscriptFileState(sessionFile);

    expect(state.getEntries().map((entry) => entry.id)).toEqual(["user-1", "assistant-1"]);
    expect(state.getLeafId()).toBe("assistant-1");
    expect(state.getBranch().map((entry) => entry.id)).toEqual(["user-1", "assistant-1"]);
  });
});
