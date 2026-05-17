import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createManagedTaskFlow, resetTaskFlowRegistryForTests } from "./task-flow-registry.js";
import {
  createTaskRecord,
  deleteTaskRecordById,
  findTaskByRunId,
  getTaskRegistrySnapshot,
  markTaskLostById,
  maybeDeliverTaskStateChangeUpdate,
  resetTaskRegistryForTests,
} from "./task-registry.js";
import { resolveTaskRegistryDir, resolveTaskRegistrySqlitePath } from "./task-registry.paths.js";
import {
  configureTaskRegistryRuntime,
  type TaskRegistryObserverEvent,
} from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

function requireFirstUpsertParams(upsertTaskWithDeliveryState: ReturnType<typeof vi.fn>): {
  task?: { taskId?: string };
  deliveryState?: { lastNotifiedEventAt?: number };
} {
  const [call] = upsertTaskWithDeliveryState.mock.calls;
  if (!call) {
    throw new Error("expected task upsert params");
  }
  const [params] = call;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("expected task upsert params to be an object");
  }
  return params;
}

function createStoredTask(): TaskRecord {
  return {
    taskId: "task-restored",
    runtime: "acp",
    sourceId: "run-restored",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    childSessionKey: "agent:codex:acp:restored",
    runId: "run-restored",
    task: "Restored task",
    status: "running",
    deliveryStatus: "pending",
    notifyPolicy: "done_only",
    createdAt: 100,
    lastEventAt: 100,
  };
}

describe("task-registry store runtime", () => {
  afterEach(() => {
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetTaskRegistryForTests();
    resetTaskFlowRegistryForTests({ persist: false });
  });

  it("uses the configured task store for restore and save", () => {
    const storedTask = createStoredTask();
    const loadSnapshot = vi.fn(() => ({
      tasks: new Map([[storedTask.taskId, storedTask]]),
      deliveryStates: new Map(),
    }));
    const saveSnapshot = vi.fn();
    configureTaskRegistryRuntime({
      store: {
        loadSnapshot,
        saveSnapshot,
      },
    });

    const restored = findTaskByRunId("run-restored");
    expect(restored?.taskId).toBe("task-restored");
    expect(restored?.task).toBe("Restored task");
    expect(loadSnapshot).toHaveBeenCalledTimes(1);

    createTaskRecord({
      runtime: "acp",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:codex:acp:new",
      runId: "run-new",
      task: "New task",
      status: "running",
      deliveryStatus: "pending",
    });

    expect(saveSnapshot).toHaveBeenCalled();
    const latestSnapshot = saveSnapshot.mock.calls[saveSnapshot.mock.calls.length - 1]?.[0] as {
      tasks: ReadonlyMap<string, TaskRecord>;
    };
    expect(latestSnapshot.tasks.size).toBe(2);
    expect(latestSnapshot.tasks.get("task-restored")?.task).toBe("Restored task");
  });

  it("emits incremental observer events for restore, mutation, and delete", () => {
    const events: TaskRegistryObserverEvent[] = [];
    configureTaskRegistryRuntime({
      store: {
        loadSnapshot: () => ({
          tasks: new Map([[createStoredTask().taskId, createStoredTask()]]),
          deliveryStates: new Map(),
        }),
        saveSnapshot: () => {},
      },
      observers: {
        onEvent: (event) => {
          events.push(event);
        },
      },
    });

    const restored = findTaskByRunId("run-restored");
    expect(restored?.runId).toBe("run-restored");
    expect(restored?.taskId).toBe("task-restored");
    expect(restored?.task).toBe("Restored task");
    const created = createTaskRecord({
      runtime: "acp",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:codex:acp:new",
      runId: "run-new",
      task: "New task",
      status: "running",
      deliveryStatus: "pending",
    });
    expect(deleteTaskRecordById(created.taskId)).toBe(true);

    expect(events.map((event) => event.kind)).toEqual(["restored", "upserted", "deleted"]);
    const restoredEvent = events[0];
    expect(restoredEvent?.kind).toBe("restored");
    if (restoredEvent?.kind !== "restored") {
      throw new Error("Expected restored observer event");
    }
    expect(restoredEvent.tasks.map((task) => task.taskId)).toEqual(["task-restored"]);

    const upsertedEvent = events[1];
    expect(upsertedEvent?.kind).toBe("upserted");
    if (upsertedEvent?.kind !== "upserted") {
      throw new Error("Expected upserted observer event");
    }
    expect(upsertedEvent.task.taskId).toBe(created.taskId);

    const deletedEvent = events[2];
    expect(deletedEvent?.kind).toBe("deleted");
    if (deletedEvent?.kind !== "deleted") {
      throw new Error("Expected deleted observer event");
    }
    expect(deletedEvent.taskId).toBe(created.taskId);
  });

  it("uses atomic task-plus-delivery store methods when available", async () => {
    const upsertTaskWithDeliveryState = vi.fn();
    const deleteTaskWithDeliveryState = vi.fn();
    configureTaskRegistryRuntime({
      store: {
        loadSnapshot: () => ({
          tasks: new Map(),
          deliveryStates: new Map(),
        }),
        saveSnapshot: vi.fn(),
        upsertTaskWithDeliveryState,
        deleteTaskWithDeliveryState,
      },
    });

    const created = createTaskRecord({
      runtime: "acp",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:codex:acp:new",
      runId: "run-atomic",
      task: "Atomic task",
      status: "running",
      notifyPolicy: "state_changes",
      deliveryStatus: "pending",
    });

    await maybeDeliverTaskStateChangeUpdate(created.taskId, {
      at: 200,
      kind: "progress",
      summary: "working",
    });
    expect(deleteTaskRecordById(created.taskId)).toBe(true);

    expect(upsertTaskWithDeliveryState).toHaveBeenCalled();
    expect(requireFirstUpsertParams(upsertTaskWithDeliveryState).task?.taskId).toBe(created.taskId);
    expect(
      upsertTaskWithDeliveryState.mock.calls.some((call) => {
        const params = call[0] as { deliveryState?: { lastNotifiedEventAt?: number } };
        return params.deliveryState?.lastNotifiedEventAt === 200;
      }),
    ).toBe(true);
    expect(deleteTaskWithDeliveryState).toHaveBeenCalledWith(created.taskId);
  });

  it("restores persisted tasks from the default sqlite store", () => {
    const created = createTaskRecord({
      runtime: "cron",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      sourceId: "job-123",
      runId: "run-sqlite",
      task: "Run nightly cron",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });

    resetTaskRegistryForTests({ persist: false });

    const restored = findTaskByRunId("run-sqlite");
    expect(restored?.taskId).toBe(created.taskId);
    expect(restored?.sourceId).toBe("job-123");
    expect(restored?.task).toBe("Run nightly cron");
  });

  it("persists parentFlowId with task rows", () => {
    const flow = createManagedTaskFlow({
      ownerKey: "agent:main:main",
      controllerId: "tests/task-store-parent-flow",
      goal: "Persist linked tasks",
    });
    const created = createTaskRecord({
      runtime: "acp",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      parentFlowId: flow.flowId,
      childSessionKey: "agent:codex:acp:new",
      runId: "run-flow-linked",
      task: "Linked task",
      status: "running",
      deliveryStatus: "pending",
    });

    resetTaskRegistryForTests({ persist: false });

    const restored = findTaskByRunId("run-flow-linked");
    expect(restored?.taskId).toBe(created.taskId);
    expect(restored?.parentFlowId).toBe(flow.flowId);
  });

  it("preserves requesterSessionKey when it differs from ownerKey across sqlite restore", () => {
    const created = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:workspace:channel:C1234567890",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:workspace:channel:C1234567890",
      runId: "run-requester-session-restore",
      task: "Reply to channel task",
      status: "running",
      deliveryStatus: "pending",
      notifyPolicy: "done_only",
    });

    resetTaskRegistryForTests({ persist: false });

    const restored = findTaskByRunId("run-requester-session-restore");
    expect(restored?.taskId).toBe(created.taskId);
    expect(restored?.requesterSessionKey).toBe("agent:main:workspace:channel:C1234567890");
    // Global-owner migration rewrites every ownerKey to "global" on store open. The original
    // owner ("agent:main:main") survives as requesterSessionKey for relevance filtering.
    expect(restored?.ownerKey).toBe("global");
    expect(restored?.childSessionKey).toBe("agent:main:workspace:channel:C1234567890");
  });

  it("drops malformed requester origin json from sqlite delivery state", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-store-origin-shape-" },
      async () => {
        const created = createTaskRecord({
          runtime: "acp",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          requesterOrigin: {
            channel: "notifychat",
            to: "notifychat:123",
          },
          childSessionKey: "agent:main:acp:origin-shape",
          runId: "run-origin-shape",
          task: "Restore malformed origin",
          status: "running",
          deliveryStatus: "pending",
          notifyPolicy: "state_changes",
        });

        const sqlitePath = resolveTaskRegistrySqlitePath(process.env);
        const { DatabaseSync } = requireNodeSqlite();
        const db = new DatabaseSync(sqlitePath);
        db.prepare(
          `INSERT OR REPLACE INTO task_delivery_state (
            task_id,
            requester_origin_json,
            last_notified_event_at
          ) VALUES (?, ?, ?)`,
        ).run(created.taskId, JSON.stringify(["notifychat", "123"]), 321);
        db.close();

        resetTaskRegistryForTests({ persist: false });

        const deliveryState = getTaskRegistrySnapshot().deliveryStates.find(
          (state) => state.taskId === created.taskId,
        );
        expect(deliveryState?.lastNotifiedEventAt).toBe(321);
        expect(deliveryState?.requesterOrigin).toBeUndefined();
      },
    );
  });

  it("preserves taskKind across sqlite restore", () => {
    const created = createTaskRecord({
      runtime: "acp",
      taskKind: "video_generation",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:codex:acp:video",
      runId: "run-task-kind-restore",
      task: "Render a short clip",
      status: "running",
      deliveryStatus: "pending",
      notifyPolicy: "done_only",
    });

    resetTaskRegistryForTests({ persist: false });

    const restored = findTaskByRunId("run-task-kind-restore");
    expect(restored?.taskId).toBe(created.taskId);
    expect(restored?.taskKind).toBe("video_generation");
    expect(restored?.runId).toBe("run-task-kind-restore");
  });

  it("hardens the sqlite task store directory and file modes", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-store-" },
      async () => {
        createTaskRecord({
          runtime: "cron",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          sourceId: "job-456",
          runId: "run-perms",
          task: "Run secured cron",
          status: "running",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
        });

        const registryDir = resolveTaskRegistryDir(process.env);
        const sqlitePath = resolveTaskRegistrySqlitePath(process.env);
        expect(statSync(registryDir).mode & 0o777).toBe(0o700);
        expect(statSync(sqlitePath).mode & 0o777).toBe(0o600);
      },
    );
  });

  it("migrates legacy ownerless cron rows to system scope", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-store-legacy-" },
      async () => {
        const sqlitePath = resolveTaskRegistrySqlitePath(process.env);
        mkdirSync(path.dirname(sqlitePath), { recursive: true });
        const { DatabaseSync } = requireNodeSqlite();
        const db = new DatabaseSync(sqlitePath);
        db.exec(`
      CREATE TABLE task_runs (
        task_id TEXT PRIMARY KEY,
        runtime TEXT NOT NULL,
        source_id TEXT,
        requester_session_key TEXT NOT NULL,
        child_session_key TEXT,
        parent_task_id TEXT,
        agent_id TEXT,
        run_id TEXT,
        label TEXT,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        delivery_status TEXT NOT NULL,
        notify_policy TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        last_event_at INTEGER,
        cleanup_after INTEGER,
        error TEXT,
        progress_summary TEXT,
        terminal_summary TEXT,
        terminal_outcome TEXT
      );
    `);
        db.exec(`
      CREATE TABLE task_delivery_state (
        task_id TEXT PRIMARY KEY,
        requester_origin_json TEXT,
        last_notified_event_at INTEGER
      );
    `);
        db.prepare(`
      INSERT INTO task_runs (
        task_id,
        runtime,
        source_id,
        requester_session_key,
        child_session_key,
        run_id,
        task,
        status,
        delivery_status,
        notify_policy,
        created_at,
        last_event_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
          "legacy-cron-task",
          "cron",
          "nightly-digest",
          "",
          "agent:main:cron:nightly-digest",
          "legacy-cron-run",
          "Nightly digest",
          "running",
          "not_applicable",
          "silent",
          100,
          100,
        );
        db.close();

        resetTaskRegistryForTests({ persist: false });

        const restored = findTaskByRunId("legacy-cron-run");
        expect(restored?.taskId).toBe("legacy-cron-task");
        // Pre-global-owner this was "system:cron:nightly-digest" (legacy column migration's
        // synthesized key). The global-owner migration now collapses this to "global".
        expect(restored?.ownerKey).toBe("global");
        expect(restored?.scopeKind).toBe("system");
        expect(restored?.deliveryStatus).toBe("not_applicable");
        expect(restored?.notifyPolicy).toBe("silent");
      },
    );
  });

  it("keeps legacy requester_session_key rows writable after restore", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-store-legacy-write-" },
      async () => {
        const sqlitePath = resolveTaskRegistrySqlitePath(process.env);
        mkdirSync(path.dirname(sqlitePath), { recursive: true });
        const { DatabaseSync } = requireNodeSqlite();
        const db = new DatabaseSync(sqlitePath);
        db.exec(`
      CREATE TABLE task_runs (
        task_id TEXT PRIMARY KEY,
        runtime TEXT NOT NULL,
        source_id TEXT,
        requester_session_key TEXT NOT NULL,
        child_session_key TEXT,
        parent_task_id TEXT,
        agent_id TEXT,
        run_id TEXT,
        label TEXT,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        delivery_status TEXT NOT NULL,
        notify_policy TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        last_event_at INTEGER,
        cleanup_after INTEGER,
        error TEXT,
        progress_summary TEXT,
        terminal_summary TEXT,
        terminal_outcome TEXT
      );
    `);
        db.exec(`
      CREATE TABLE task_delivery_state (
        task_id TEXT PRIMARY KEY,
        requester_origin_json TEXT,
        last_notified_event_at INTEGER
      );
    `);
        db.prepare(`
      INSERT INTO task_runs (
        task_id,
        runtime,
        requester_session_key,
        run_id,
        task,
        status,
        delivery_status,
        notify_policy,
        created_at,
        last_event_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
          "legacy-session-task",
          "acp",
          "agent:main:main",
          "legacy-session-run",
          "Legacy session task",
          "running",
          "pending",
          "done_only",
          100,
          100,
        );
        db.close();

        resetTaskRegistryForTests({ persist: false });

        const lost = markTaskLostById({
          taskId: "legacy-session-task",
          endedAt: 200,
          lastEventAt: 200,
          error: "session missing",
        });
        expect(lost?.taskId).toBe("legacy-session-task");
        expect(lost?.status).toBe("lost");
        expect(lost?.error).toBe("session missing");
        const restored = findTaskByRunId("legacy-session-run");
        expect(restored?.taskId).toBe("legacy-session-task");
        expect(restored?.status).toBe("lost");
        expect(restored?.error).toBe("session missing");
      },
    );
  });

  it("rewrites all owner_key values to 'global' on store open (global-owner migration)", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-store-global-owner-" },
      async () => {
        const sqlitePath = resolveTaskRegistrySqlitePath(process.env);
        mkdirSync(path.dirname(sqlitePath), { recursive: true });
        const { DatabaseSync } = requireNodeSqlite();
        const db = new DatabaseSync(sqlitePath);
        db.exec(`
          CREATE TABLE task_runs (
            task_id TEXT PRIMARY KEY,
            runtime TEXT NOT NULL,
            source_id TEXT,
            requester_session_key TEXT,
            owner_key TEXT NOT NULL,
            scope_kind TEXT NOT NULL DEFAULT 'session',
            run_id TEXT,
            task TEXT NOT NULL,
            status TEXT NOT NULL,
            delivery_status TEXT NOT NULL,
            notify_policy TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            last_event_at INTEGER
          );
        `);
        db.exec(`
          CREATE TABLE task_delivery_state (
            task_id TEXT PRIMARY KEY,
            requester_origin_json TEXT,
            last_notified_event_at INTEGER
          );
        `);
        const insert = db.prepare(`
          INSERT INTO task_runs (
            task_id, runtime, requester_session_key, owner_key, scope_kind,
            run_id, task, status, delivery_status, notify_policy,
            created_at, last_event_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        insert.run(
          "t-channel",
          "agent",
          "slack:channel:C0XYZ",
          "slack:channel:C0XYZ",
          "session",
          null,
          "from channel",
          "queued",
          "not_applicable",
          "silent",
          100,
          100,
        );
        insert.run(
          "t-thread",
          "agent",
          "slack:channel:C0XYZ:thread:T123",
          "slack:channel:C0XYZ:thread:T123",
          "session",
          null,
          "from thread",
          "queued",
          "not_applicable",
          "silent",
          101,
          101,
        );
        insert.run(
          "t-subagent",
          "subagent",
          "agent:main:main",
          "agent:main:main",
          "session",
          "run-sa",
          "subagent task",
          "running",
          "pending",
          "done_only",
          102,
          102,
        );
        db.close();

        resetTaskRegistryForTests({ persist: false });
        // Trigger registry hydration → opens the SQLite store → runs ensureSchema → migration.
        findTaskByRunId("__trigger_open__");

        const verify = new DatabaseSync(sqlitePath);
        const rows = verify
          .prepare(`SELECT task_id, owner_key FROM task_runs ORDER BY task_id`)
          .all() as Array<{ task_id: string; owner_key: string }>;
        verify.close();
        expect(rows).toHaveLength(3);
        for (const row of rows) {
          expect(row.owner_key).toBe("global");
        }
      },
    );
  });

  it("global-owner migration is idempotent on re-open", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-store-global-owner-idem-" },
      async () => {
        const sqlitePath = resolveTaskRegistrySqlitePath(process.env);
        mkdirSync(path.dirname(sqlitePath), { recursive: true });
        const { DatabaseSync } = requireNodeSqlite();
        const db = new DatabaseSync(sqlitePath);
        db.exec(`
          CREATE TABLE task_runs (
            task_id TEXT PRIMARY KEY,
            runtime TEXT NOT NULL,
            source_id TEXT,
            requester_session_key TEXT,
            owner_key TEXT NOT NULL,
            scope_kind TEXT NOT NULL DEFAULT 'session',
            run_id TEXT,
            task TEXT NOT NULL,
            status TEXT NOT NULL,
            delivery_status TEXT NOT NULL,
            notify_policy TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            last_event_at INTEGER
          );
        `);
        db.exec(`
          CREATE TABLE task_delivery_state (
            task_id TEXT PRIMARY KEY,
            requester_origin_json TEXT,
            last_notified_event_at INTEGER
          );
        `);
        db.prepare(`
          INSERT INTO task_runs (
            task_id, runtime, requester_session_key, owner_key, scope_kind,
            run_id, task, status, delivery_status, notify_policy,
            created_at, last_event_at
          ) VALUES ('t1', 'agent', 's1', 'global', 'session', NULL, 'already-global',
                    'queued', 'not_applicable', 'silent', 100, 100)
        `).run();
        db.close();

        // First open: migration runs (no-op since already 'global').
        resetTaskRegistryForTests({ persist: false });
        findTaskByRunId("__open1__");
        // Second open: migration runs again (still no-op).
        resetTaskRegistryForTests({ persist: false });
        findTaskByRunId("__open2__");

        const verify = new DatabaseSync(sqlitePath);
        const row = verify.prepare(`SELECT owner_key FROM task_runs WHERE task_id = 't1'`).get() as
          | { owner_key: string }
          | undefined;
        verify.close();
        expect(row?.owner_key).toBe("global");
      },
    );
  });
});
