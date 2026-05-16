import { chmodSync, existsSync, mkdirSync } from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { configureSqliteWalMaintenance, type SqliteWalMaintenance } from "../infra/sqlite-wal.js";
import { resolveExtrapolationDir, resolveExtrapolationSqlitePath } from "./paths.js";
import type {
  ExtrapolationAuditRecord,
  ExtrapolationDirection,
  ExtrapolationGraphRecord,
  ExtrapolationGraphStatus,
  ExtrapolationNodeKind,
  ExtrapolationNodeRecord,
  ExtrapolationNodeStatus,
  SessionDurableFactRecord,
} from "./types.js";

type GraphRow = {
  graph_id: string;
  root_request: string;
  owner_key: string;
  session_key: string;
  agent_id: string;
  flow_id: string | null;
  status: ExtrapolationGraphStatus;
  iteration: number | bigint;
  budget_nodes: number | bigint;
  revision_token: number | bigint;
  resolved_at: number | bigint | null;
  abandoned_reason: string | null;
  created_at: number | bigint;
  updated_at: number | bigint;
};

type NodeRow = {
  node_id: string;
  graph_id: string;
  parent_node_id: string | null;
  direction: ExtrapolationDirection;
  kind: ExtrapolationNodeKind;
  content: string;
  confidence: number;
  relevance: number;
  status: ExtrapolationNodeStatus;
  resolution: string | null;
  promoted_task_id: string | null;
  promoted_child_session_key: string | null;
  created_at: number | bigint;
  updated_at: number | bigint;
  resolved_at: number | bigint | null;
};

type AuditRow = {
  audit_id: number | bigint;
  graph_id: string;
  iteration: number | bigint;
  at: number | bigint;
  kind: ExtrapolationAuditRecord["kind"];
  content_json: string;
};

type FactRow = {
  fact_id: string;
  owner_key: string;
  session_key: string;
  kind: ExtrapolationNodeKind;
  content: string;
  content_hash: string;
  confidence: number;
  reinforcement: number | bigint;
  source_graph_ids: string;
  created_at: number | bigint;
  updated_at: number | bigint;
  revoked_at: number | bigint | null;
};

type Statements = {
  insertGraph: StatementSync;
  updateGraph: StatementSync;
  selectGraphById: StatementSync;
  selectGraphsBySession: StatementSync;
  selectGraphsByOwner: StatementSync;
  selectGraphsByStatus: StatementSync;
  insertNode: StatementSync;
  updateNode: StatementSync;
  selectNodeById: StatementSync;
  selectNodesByGraph: StatementSync;
  insertAudit: StatementSync;
  selectAuditByGraph: StatementSync;
  insertFact: StatementSync;
  updateFact: StatementSync;
  selectFactsBySession: StatementSync;
  selectFactsBySessionKey: StatementSync;
  selectFactByHash: StatementSync;
};

type StoreDatabase = {
  db: DatabaseSync;
  path: string;
  statements: Statements;
  walMaintenance: SqliteWalMaintenance;
};

let cached: StoreDatabase | null = null;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const SIDECAR_SUFFIXES = ["", "-shm", "-wal"] as const;

function toNumber(value: number | bigint | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  return typeof value === "bigint" ? Number(value) : value;
}

function toNumberRequired(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function ensurePermissions(pathname: string) {
  const dir = resolveExtrapolationDir(process.env);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodSync(dir, DIR_MODE);
  for (const suffix of SIDECAR_SUFFIXES) {
    const candidate = `${pathname}${suffix}`;
    if (existsSync(candidate)) {
      chmodSync(candidate, FILE_MODE);
    }
  }
}

function ensureSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS extrapolation_graphs (
      graph_id          TEXT PRIMARY KEY,
      root_request      TEXT NOT NULL,
      owner_key         TEXT NOT NULL,
      session_key       TEXT NOT NULL,
      agent_id          TEXT NOT NULL,
      flow_id           TEXT,
      status            TEXT NOT NULL,
      iteration         INTEGER NOT NULL DEFAULT 0,
      budget_nodes      INTEGER NOT NULL DEFAULT 50,
      revision_token    INTEGER NOT NULL DEFAULT 0,
      resolved_at       INTEGER,
      abandoned_reason  TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_eg_owner_key ON extrapolation_graphs(owner_key);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_eg_session_key ON extrapolation_graphs(session_key);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_eg_status ON extrapolation_graphs(status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_eg_flow_id ON extrapolation_graphs(flow_id);`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS extrapolation_nodes (
      node_id                     TEXT PRIMARY KEY,
      graph_id                    TEXT NOT NULL,
      parent_node_id              TEXT,
      direction                   TEXT NOT NULL,
      kind                        TEXT NOT NULL,
      content                     TEXT NOT NULL,
      confidence                  REAL NOT NULL DEFAULT 0.5,
      relevance                   REAL NOT NULL DEFAULT 0.5,
      status                      TEXT NOT NULL,
      resolution                  TEXT,
      promoted_task_id            TEXT,
      promoted_child_session_key  TEXT,
      created_at                  INTEGER NOT NULL,
      updated_at                  INTEGER NOT NULL,
      resolved_at                 INTEGER
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_en_graph_id ON extrapolation_nodes(graph_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_en_status ON extrapolation_nodes(status);`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_en_direction_kind ON extrapolation_nodes(direction, kind);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_en_promoted_task_id ON extrapolation_nodes(promoted_task_id);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_en_parent_node_id ON extrapolation_nodes(parent_node_id);`,
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS extrapolation_audit (
      audit_id     INTEGER PRIMARY KEY AUTOINCREMENT,
      graph_id     TEXT NOT NULL,
      iteration    INTEGER NOT NULL,
      at           INTEGER NOT NULL,
      kind         TEXT NOT NULL,
      content_json TEXT NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ea_graph_at ON extrapolation_audit(graph_id, at);`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS session_durable_facts (
      fact_id          TEXT PRIMARY KEY,
      owner_key        TEXT NOT NULL,
      session_key      TEXT NOT NULL,
      kind             TEXT NOT NULL,
      content          TEXT NOT NULL,
      content_hash     TEXT NOT NULL,
      confidence       REAL NOT NULL,
      reinforcement    INTEGER NOT NULL,
      source_graph_ids TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      revoked_at       INTEGER
    );
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_sdf_owner_session ON session_durable_facts(owner_key, session_key);`,
  );
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sdf_content_hash_session
    ON session_durable_facts(session_key, content_hash) WHERE revoked_at IS NULL;
  `);
}

function createStatements(db: DatabaseSync): Statements {
  return {
    insertGraph: db.prepare(`
      INSERT INTO extrapolation_graphs (
        graph_id, root_request, owner_key, session_key, agent_id, flow_id,
        status, iteration, budget_nodes, revision_token,
        resolved_at, abandoned_reason, created_at, updated_at
      ) VALUES (
        @graph_id, @root_request, @owner_key, @session_key, @agent_id, @flow_id,
        @status, @iteration, @budget_nodes, @revision_token,
        @resolved_at, @abandoned_reason, @created_at, @updated_at
      )
    `),
    updateGraph: db.prepare(`
      UPDATE extrapolation_graphs SET
        flow_id = @flow_id,
        status = @status,
        iteration = @iteration,
        budget_nodes = @budget_nodes,
        revision_token = @revision_token,
        resolved_at = @resolved_at,
        abandoned_reason = @abandoned_reason,
        updated_at = @updated_at
      WHERE graph_id = @graph_id AND revision_token = @expected_revision_token
    `),
    selectGraphById: db.prepare(`SELECT * FROM extrapolation_graphs WHERE graph_id = ?`),
    selectGraphsBySession: db.prepare(`
      SELECT * FROM extrapolation_graphs WHERE session_key = ? ORDER BY created_at ASC
    `),
    selectGraphsByOwner: db.prepare(`
      SELECT * FROM extrapolation_graphs WHERE owner_key = ? ORDER BY created_at ASC
    `),
    selectGraphsByStatus: db.prepare(`
      SELECT * FROM extrapolation_graphs WHERE status = ? ORDER BY created_at ASC
    `),
    insertNode: db.prepare(`
      INSERT INTO extrapolation_nodes (
        node_id, graph_id, parent_node_id, direction, kind, content,
        confidence, relevance, status, resolution,
        promoted_task_id, promoted_child_session_key,
        created_at, updated_at, resolved_at
      ) VALUES (
        @node_id, @graph_id, @parent_node_id, @direction, @kind, @content,
        @confidence, @relevance, @status, @resolution,
        @promoted_task_id, @promoted_child_session_key,
        @created_at, @updated_at, @resolved_at
      )
    `),
    updateNode: db.prepare(`
      UPDATE extrapolation_nodes SET
        status = @status,
        confidence = @confidence,
        relevance = @relevance,
        resolution = @resolution,
        promoted_task_id = @promoted_task_id,
        promoted_child_session_key = @promoted_child_session_key,
        updated_at = @updated_at,
        resolved_at = @resolved_at
      WHERE node_id = @node_id
    `),
    selectNodeById: db.prepare(`SELECT * FROM extrapolation_nodes WHERE node_id = ?`),
    selectNodesByGraph: db.prepare(`
      SELECT * FROM extrapolation_nodes WHERE graph_id = ? ORDER BY created_at ASC, node_id ASC
    `),
    insertAudit: db.prepare(`
      INSERT INTO extrapolation_audit (graph_id, iteration, at, kind, content_json)
      VALUES (@graph_id, @iteration, @at, @kind, @content_json)
    `),
    selectAuditByGraph: db.prepare(`
      SELECT * FROM extrapolation_audit WHERE graph_id = ? ORDER BY at ASC, audit_id ASC
    `),
    insertFact: db.prepare(`
      INSERT INTO session_durable_facts (
        fact_id, owner_key, session_key, kind, content, content_hash,
        confidence, reinforcement, source_graph_ids,
        created_at, updated_at, revoked_at
      ) VALUES (
        @fact_id, @owner_key, @session_key, @kind, @content, @content_hash,
        @confidence, @reinforcement, @source_graph_ids,
        @created_at, @updated_at, @revoked_at
      )
    `),
    updateFact: db.prepare(`
      UPDATE session_durable_facts SET
        content = @content,
        confidence = @confidence,
        reinforcement = @reinforcement,
        source_graph_ids = @source_graph_ids,
        updated_at = @updated_at,
        revoked_at = @revoked_at
      WHERE fact_id = @fact_id
    `),
    selectFactsBySession: db.prepare(`
      SELECT * FROM session_durable_facts
      WHERE owner_key = ? AND session_key = ? AND revoked_at IS NULL
      ORDER BY created_at ASC
    `),
    selectFactsBySessionKey: db.prepare(`
      SELECT * FROM session_durable_facts
      WHERE session_key = ? AND revoked_at IS NULL
      ORDER BY created_at ASC
    `),
    selectFactByHash: db.prepare(`
      SELECT * FROM session_durable_facts
      WHERE session_key = ? AND content_hash = ? AND revoked_at IS NULL
      LIMIT 1
    `),
  };
}

function openDatabase(): StoreDatabase {
  const pathname = resolveExtrapolationSqlitePath(process.env);
  if (cached && cached.path === pathname) {
    return cached;
  }
  if (cached) {
    cached.walMaintenance.close();
    cached.db.close();
    cached = null;
  }
  ensurePermissions(pathname);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(pathname);
  const walMaintenance = configureSqliteWalMaintenance(db);
  db.exec(`PRAGMA synchronous = NORMAL;`);
  db.exec(`PRAGMA busy_timeout = 5000;`);
  ensureSchema(db);
  ensurePermissions(pathname);
  cached = { db, path: pathname, statements: createStatements(db), walMaintenance };
  return cached;
}

function withWriteTransaction<T>(write: (statements: Statements) => T): T {
  const store = openDatabase();
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const result = write(store.statements);
    store.db.exec("COMMIT");
    ensurePermissions(store.path);
    return result;
  } catch (err) {
    store.db.exec("ROLLBACK");
    throw err;
  }
}

function rowToGraph(row: GraphRow): ExtrapolationGraphRecord {
  const resolvedAt = toNumber(row.resolved_at);
  return {
    graphId: row.graph_id,
    rootRequest: row.root_request,
    ownerKey: row.owner_key,
    sessionKey: row.session_key,
    agentId: row.agent_id,
    ...(row.flow_id ? { flowId: row.flow_id } : {}),
    status: row.status,
    iteration: toNumberRequired(row.iteration),
    budgetNodes: toNumberRequired(row.budget_nodes),
    revisionToken: toNumberRequired(row.revision_token),
    ...(resolvedAt != null ? { resolvedAt } : {}),
    ...(row.abandoned_reason ? { abandonedReason: row.abandoned_reason } : {}),
    createdAt: toNumberRequired(row.created_at),
    updatedAt: toNumberRequired(row.updated_at),
  };
}

function rowToNode(row: NodeRow): ExtrapolationNodeRecord {
  const resolvedAt = toNumber(row.resolved_at);
  return {
    nodeId: row.node_id,
    graphId: row.graph_id,
    ...(row.parent_node_id ? { parentNodeId: row.parent_node_id } : {}),
    direction: row.direction,
    kind: row.kind,
    content: row.content,
    confidence: row.confidence,
    relevance: row.relevance,
    status: row.status,
    ...(row.resolution ? { resolution: row.resolution } : {}),
    ...(row.promoted_task_id ? { promotedTaskId: row.promoted_task_id } : {}),
    ...(row.promoted_child_session_key
      ? { promotedChildSessionKey: row.promoted_child_session_key }
      : {}),
    createdAt: toNumberRequired(row.created_at),
    updatedAt: toNumberRequired(row.updated_at),
    ...(resolvedAt != null ? { resolvedAt } : {}),
  };
}

function rowToAudit(row: AuditRow): ExtrapolationAuditRecord {
  return {
    auditId: toNumberRequired(row.audit_id),
    graphId: row.graph_id,
    iteration: toNumberRequired(row.iteration),
    at: toNumberRequired(row.at),
    kind: row.kind,
    contentJson: row.content_json,
  };
}

function rowToFact(row: FactRow): SessionDurableFactRecord {
  const revokedAt = toNumber(row.revoked_at);
  let parsedSources: ReadonlyArray<string>;
  try {
    const parsed = JSON.parse(row.source_graph_ids) as unknown;
    parsedSources = Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    parsedSources = [];
  }
  return {
    factId: row.fact_id,
    ownerKey: row.owner_key,
    sessionKey: row.session_key,
    kind: row.kind,
    content: row.content,
    contentHash: row.content_hash,
    confidence: row.confidence,
    reinforcement: toNumberRequired(row.reinforcement),
    sourceGraphIds: parsedSources,
    createdAt: toNumberRequired(row.created_at),
    updatedAt: toNumberRequired(row.updated_at),
    ...(revokedAt != null ? { revokedAt } : {}),
  };
}

function bindGraph(record: ExtrapolationGraphRecord) {
  return {
    graph_id: record.graphId,
    root_request: record.rootRequest,
    owner_key: record.ownerKey,
    session_key: record.sessionKey,
    agent_id: record.agentId,
    flow_id: record.flowId ?? null,
    status: record.status,
    iteration: record.iteration,
    budget_nodes: record.budgetNodes,
    revision_token: record.revisionToken,
    resolved_at: record.resolvedAt ?? null,
    abandoned_reason: record.abandonedReason ?? null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function bindNode(record: ExtrapolationNodeRecord) {
  return {
    node_id: record.nodeId,
    graph_id: record.graphId,
    parent_node_id: record.parentNodeId ?? null,
    direction: record.direction,
    kind: record.kind,
    content: record.content,
    confidence: record.confidence,
    relevance: record.relevance,
    status: record.status,
    resolution: record.resolution ?? null,
    promoted_task_id: record.promotedTaskId ?? null,
    promoted_child_session_key: record.promotedChildSessionKey ?? null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    resolved_at: record.resolvedAt ?? null,
  };
}

function bindFact(record: SessionDurableFactRecord) {
  return {
    fact_id: record.factId,
    owner_key: record.ownerKey,
    session_key: record.sessionKey,
    kind: record.kind,
    content: record.content,
    content_hash: record.contentHash,
    confidence: record.confidence,
    reinforcement: record.reinforcement,
    source_graph_ids: JSON.stringify(record.sourceGraphIds),
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    revoked_at: record.revokedAt ?? null,
  };
}

export function insertGraphRecord(record: ExtrapolationGraphRecord): void {
  withWriteTransaction((statements) => {
    statements.insertGraph.run(bindGraph(record));
  });
}

export function updateGraphRecord(
  record: ExtrapolationGraphRecord,
  expectedRevisionToken: number,
): boolean {
  return withWriteTransaction((statements) => {
    const result = statements.updateGraph.run({
      graph_id: record.graphId,
      flow_id: record.flowId ?? null,
      status: record.status,
      iteration: record.iteration,
      budget_nodes: record.budgetNodes,
      revision_token: record.revisionToken,
      resolved_at: record.resolvedAt ?? null,
      abandoned_reason: record.abandonedReason ?? null,
      updated_at: record.updatedAt,
      expected_revision_token: expectedRevisionToken,
    });
    return toNumberRequired(result.changes) > 0;
  });
}

export function selectGraphById(graphId: string): ExtrapolationGraphRecord | undefined {
  const row = openDatabase().statements.selectGraphById.get(graphId) as GraphRow | undefined;
  return row ? rowToGraph(row) : undefined;
}

export function selectGraphsBySession(sessionKey: string): ExtrapolationGraphRecord[] {
  const rows = openDatabase().statements.selectGraphsBySession.all(sessionKey) as GraphRow[];
  return rows.map(rowToGraph);
}

export function selectGraphsByOwner(ownerKey: string): ExtrapolationGraphRecord[] {
  const rows = openDatabase().statements.selectGraphsByOwner.all(ownerKey) as GraphRow[];
  return rows.map(rowToGraph);
}

export function selectGraphsByStatus(status: ExtrapolationGraphStatus): ExtrapolationGraphRecord[] {
  const rows = openDatabase().statements.selectGraphsByStatus.all(status) as GraphRow[];
  return rows.map(rowToGraph);
}

export function insertNodeRecord(record: ExtrapolationNodeRecord): void {
  withWriteTransaction((statements) => {
    statements.insertNode.run(bindNode(record));
  });
}

export function updateNodeRecord(record: ExtrapolationNodeRecord): void {
  withWriteTransaction((statements) => {
    statements.updateNode.run({
      node_id: record.nodeId,
      status: record.status,
      confidence: record.confidence,
      relevance: record.relevance,
      resolution: record.resolution ?? null,
      promoted_task_id: record.promotedTaskId ?? null,
      promoted_child_session_key: record.promotedChildSessionKey ?? null,
      updated_at: record.updatedAt,
      resolved_at: record.resolvedAt ?? null,
    });
  });
}

export function selectNodeById(nodeId: string): ExtrapolationNodeRecord | undefined {
  const row = openDatabase().statements.selectNodeById.get(nodeId) as NodeRow | undefined;
  return row ? rowToNode(row) : undefined;
}

export function selectNodesByGraph(graphId: string): ExtrapolationNodeRecord[] {
  const rows = openDatabase().statements.selectNodesByGraph.all(graphId) as NodeRow[];
  return rows.map(rowToNode);
}

export function insertAuditRecord(record: ExtrapolationAuditRecord): void {
  withWriteTransaction((statements) => {
    statements.insertAudit.run({
      graph_id: record.graphId,
      iteration: record.iteration,
      at: record.at,
      kind: record.kind,
      content_json: record.contentJson,
    });
  });
}

export function selectAuditByGraph(graphId: string): ExtrapolationAuditRecord[] {
  const rows = openDatabase().statements.selectAuditByGraph.all(graphId) as AuditRow[];
  return rows.map(rowToAudit);
}

export function insertFactRecord(record: SessionDurableFactRecord): void {
  withWriteTransaction((statements) => {
    statements.insertFact.run(bindFact(record));
  });
}

export function updateFactRecord(record: SessionDurableFactRecord): void {
  withWriteTransaction((statements) => {
    statements.updateFact.run({
      fact_id: record.factId,
      content: record.content,
      confidence: record.confidence,
      reinforcement: record.reinforcement,
      source_graph_ids: JSON.stringify(record.sourceGraphIds),
      updated_at: record.updatedAt,
      revoked_at: record.revokedAt ?? null,
    });
  });
}

export function selectFactsBySession(
  ownerKey: string,
  sessionKey: string,
): SessionDurableFactRecord[] {
  const rows = openDatabase().statements.selectFactsBySession.all(
    ownerKey,
    sessionKey,
  ) as FactRow[];
  return rows.map(rowToFact);
}

export function selectFactsBySessionKey(sessionKey: string): SessionDurableFactRecord[] {
  const rows = openDatabase().statements.selectFactsBySessionKey.all(sessionKey) as FactRow[];
  return rows.map(rowToFact);
}

export function selectFactByHash(
  sessionKey: string,
  contentHash: string,
): SessionDurableFactRecord | undefined {
  const row = openDatabase().statements.selectFactByHash.get(sessionKey, contentHash) as
    | FactRow
    | undefined;
  return row ? rowToFact(row) : undefined;
}

export function closeExtrapolationStore(): void {
  if (!cached) {
    return;
  }
  cached.walMaintenance.close();
  cached.db.close();
  cached = null;
}
