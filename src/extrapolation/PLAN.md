# Extrapolation Substrate — Plan

This doc tracks the phased build-out of the structured-reasoning substrate
under `src/extrapolation/`. Each phase ships as its own PR stacked on the
previous one. The substrate is **off by default** — every behavior here is
gated behind `extrapolation.enabled` in `config.openclaw.json`.

## Shipped phases

### Phase 1 — Substrate

Schema, registry, state machine, store. SQLite backing tables for graphs,
nodes, audit, and `session_durable_facts`. No runtime behavior — pure
plumbing.

### Phase 2a — Runtime

Tool surface (`seed`, `update`, `close`, deferred `revise`). Seed pass calls
the gateway agent with a JSON-only system prompt and persists the returned
nodes. Per-turn context injection groups nodes by kind into a system-prompt
block.

### Phase 2b — Task integration

Real revision pass via the gateway, hooked into `finalizeTaskRunByRunId`.
`promoteExtrapolationNodeAfterSpawn` marks the source node promoted, links
runs to a managed Task Flow, and auto-creates the flow on the 2nd promotion
in a graph.

### Phase 2c — Sweeper + backward-chain prefix + cron ids

Pure-function sweeper with iteration cap + orphaned-session abandonment.
Backward-chain prefix prepended to spawned-subagent task descriptions.
Optional `extrapolationGraphId`/`extrapolationNodeId` threaded through cron
job + task-run creation paths.

### Phase 3 — Durable-facts memory promotion

`promoteBackwardNodeIfReinforced` upserts canonicalised backward-node content
into `session_durable_facts` once distinct-graph reinforcement crosses
threshold. `getDurableFactsForSession` reader feeds the seed pass. Sweeper
gains a backfill pass for the config-off-then-on case.

### Phase 4 — Read-side completion

Per-turn `renderExtrapolationContext` now renders an "Established context"
block above active graphs. Explicit `revoke_fact` tool action lets the agent
soft-delete a fact by `(kind, content)`. SessionKey-only fact reader
(`getDurableFactsBySessionKey`) so the embedded runner doesn't need
ownerKey at the rendering boundary.

## Phase 5 candidates (not yet started)

These are the next things on deck. None are committed; pick when ready.

### Decay (deliberately deferred)

Right now a promoted fact lives forever unless revoked. A natural extension
is to halve `confidence` when N graphs in the session close without
re-reinforcing the fact, and to auto-revoke when confidence falls below
`confidenceFloor`. Trade-off: it adds runtime cost to the sweeper and
requires deciding how to count "graphs that should have reinforced this."
**Why deferred**: we want to see how revocation behaves under real agent
traffic before adding implicit pruning. Explicit `revoke_fact` is the
primary trim mechanism for now.

### Cross-session promotion

Today the unique index is `(session_key, content_hash)`. Cross-session
promotion would need a different identity (most likely
`(owner_key, content_hash)`) and a confidence model that distinguishes
"this is true in this session" from "this is generally true about this
owner." Bigger redesign — schema migration, two-tier reader, fact-origin
audit.

### LLM-derived canonical form

`canonicalizeFactContent` is lowercase + collapsed whitespace. If dedup
quality turns out to be poor in practice (e.g. "ship the renewals dashboard"
vs "ship renewals dashboard"), replace with an LLM normalization step
(probably batched at promotion time). Cheap to swap later because the
canonical form only affects the hash, not the stored content.

### Inspection / debug surfaces

A read-only tool action (`list_facts` or similar) that surfaces durable
facts to the agent on demand, without waiting for the next system-prompt
render. Useful when debugging or when the agent wants to audit before
revoking. Cheap to build once we hit the need.

### Sweeper cadence wiring

The sweeper is a pure tick function with no scheduler. We're calling it
implicitly via the integration tests; production needs to call it from a
cron or heartbeat hook. This is a runtime concern, not a substrate change.
