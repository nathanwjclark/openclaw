import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listTasksForOwnerKey } from "./runtime-internal.js";
import { GLOBAL_OWNER_KEY, type TaskRecord, type TaskStatus } from "./task-registry.types.js";

const DEFAULT_RECENT_TERMINAL_LIMIT = 10;
const DEFAULT_ACTIVE_LIMIT = 50;
const SUMMARY_TRUNCATE_CHARS = 140;

export type TasksContextInjectionInput = {
  ownerKey: string;
};

export type TasksContextInjectionResult = {
  rendered: string;
  activeCount: number;
  terminalCount: number;
};

const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set(["queued", "running"]);

function isActiveStatus(status: TaskStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

function truncateSummary(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length <= SUMMARY_TRUNCATE_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, SUMMARY_TRUNCATE_CHARS - 1)}…`;
}

function renderActiveLine(task: TaskRecord): string {
  const label = task.label
    ? `"${task.label}"`
    : `"${truncateSummary(task.task) ?? "(no description)"}"`;
  const progress = truncateSummary(task.progressSummary);
  const runtimeNote = task.runtime !== "agent" ? ` [${task.runtime}]` : "";
  const linkage = task.childSessionKey ? ` (child: ${task.childSessionKey})` : "";
  const suffix = progress ? ` — progress: ${progress}` : "";
  return `- [${task.status}] ${task.taskId} ${label}${runtimeNote}${linkage}${suffix}`;
}

function renderTerminalLine(task: TaskRecord): string {
  const label = task.label
    ? `"${task.label}"`
    : `"${truncateSummary(task.task) ?? "(no description)"}"`;
  const summary = truncateSummary(task.terminalSummary);
  const outcome = task.terminalOutcome ? ` outcome=${task.terminalOutcome}` : "";
  const runtimeNote = task.runtime !== "agent" ? ` [${task.runtime}]` : "";
  const suffix = summary ? ` — ${summary}` : "";
  return `- [${task.status}${outcome}] ${task.taskId} ${label}${runtimeNote}${suffix}`;
}

export function renderTasksContext(
  input: TasksContextInjectionInput,
  options: { activeLimit?: number; recentTerminalLimit?: number } = {},
): TasksContextInjectionResult {
  const owner = input.ownerKey.trim();
  if (!owner) {
    return { rendered: "", activeCount: 0, terminalCount: 0 };
  }
  const all = listTasksForOwnerKey(owner);
  const active: TaskRecord[] = [];
  const terminal: TaskRecord[] = [];
  for (const task of all) {
    if (isActiveStatus(task.status)) {
      active.push(task);
    } else {
      terminal.push(task);
    }
  }
  // Deterministic ordering so prompt cache stays warm:
  // - Active sorted by createdAt asc (stable across turns, new ones append at the end).
  // - Terminal sorted by endedAt desc (most recently completed first), tie-break on createdAt.
  active.sort((a, b) => a.createdAt - b.createdAt || a.taskId.localeCompare(b.taskId));
  terminal.sort((a, b) => {
    const aEnd = a.endedAt ?? a.lastEventAt ?? a.createdAt;
    const bEnd = b.endedAt ?? b.lastEventAt ?? b.createdAt;
    if (bEnd !== aEnd) {
      return bEnd - aEnd;
    }
    return a.taskId.localeCompare(b.taskId);
  });
  const activeLimit = options.activeLimit ?? DEFAULT_ACTIVE_LIMIT;
  const terminalLimit = options.recentTerminalLimit ?? DEFAULT_RECENT_TERMINAL_LIMIT;
  const activeSlice = active.slice(0, activeLimit);
  const terminalSlice = terminal.slice(0, terminalLimit);
  if (activeSlice.length === 0 && terminalSlice.length === 0) {
    return { rendered: "", activeCount: 0, terminalCount: 0 };
  }

  const lines: string[] = ["## Open tasks (durable, cross-session)"];
  lines.push(
    "Tasks tracked in `openclaw tasks list` for this owner. Use the `tasks` tool to create / update_progress / complete. Check here when starting a turn to orient on prior work and avoid duplicates.",
  );
  if (activeSlice.length > 0) {
    lines.push("", `### Active (${active.length})`);
    for (const task of activeSlice) {
      lines.push(renderActiveLine(task));
    }
    if (active.length > activeSlice.length) {
      lines.push(`- … and ${active.length - activeSlice.length} more`);
    }
  } else {
    lines.push("", "### Active (0)");
    lines.push("- (none)");
  }
  if (terminalSlice.length > 0) {
    lines.push(
      "",
      `### Recently completed (${terminal.length} total, showing ${terminalSlice.length})`,
    );
    for (const task of terminalSlice) {
      lines.push(renderTerminalLine(task));
    }
  }
  return {
    rendered: lines.join("\n"),
    activeCount: active.length,
    terminalCount: terminal.length,
  };
}

export type RunTasksContextInput = {
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
};

export function renderTasksContextForRun(input: RunTasksContextInput): TasksContextInjectionResult {
  const sessionKey = input.sessionKey?.trim();
  if (!sessionKey) {
    return { rendered: "", activeCount: 0, terminalCount: 0 };
  }
  // Feature is gated by the agent-tasks experimental flag — when the tool is enabled, so is
  // the context injection (decision: always on). Default is enabled; explicit `false` opts out.
  if (input.config?.tools?.experimental?.agentTasks === false) {
    return { rendered: "", activeCount: 0, terminalCount: 0 };
  }
  // Single-agent install: all tasks share GLOBAL_OWNER_KEY regardless of which session created
  // them. The agent uses requesterSessionKey on each rendered line to decide relevance.
  return renderTasksContext({ ownerKey: GLOBAL_OWNER_KEY });
}
