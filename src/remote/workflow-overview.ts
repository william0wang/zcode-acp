/**
 * Machine-level workflow overview for remote clients (the hub's
 * `GET /api/workflow-overview`).
 *
 * The per-instance settings routes answer with each BRIDGE's own slice: a
 * workspace with two bridges (editor + serve) yields two project groups for
 * the same project, and a bridge only sees the runs of its own cwd — so a
 * client polling "is anything flying?" against the one instance it happens to
 * be attached to reads an empty list while another project's run is very much
 * alive (observed 2026-10-01: the management page double-listed ai-hot-app
 * and its live-run zone showed nothing). Every part of that story is
 * machine-level data:
 *
 * - the dwf journal (run history) is ONE sqlite store shared by every backend
 *   process — any bridge's `workflows/runs?scope=global` read (no cwd filter)
 *   answers for the whole machine, each row carrying its own `cwd`;
 * - the saved-workflow FILES are per workspace, so the project list needs one
 *   bridge per workspace — but every bridge of that workspace reads the same
 *   directory, so ONE representative suffices;
 * - the global saved-workflow directory is machine-wide, so one global group
 *   is enough;
 * - and a journal row can LIE about a living run: upstream's orphan
 *   reconciliation writes stopped(interrupted) onto runs that are still
 *   executing in another process (and the row never flips back mid-run), so
 *   rows carrying that signature are cross-checked against the owning
 *   process's live read before the overview trusts them (collectLiveOverrides).
 *
 * This module folds all of that server-side (the hub owns the instance map):
 * dedupe instances to one group per workspace, race the pair reads with the
 * freshest-started bridge preferred (an old long-lived bridge may predate the
 * workflow routes — fall back to a sibling that answers), and answer with a
 * ready-to-render list plus the machine-wide `activeRuns` (journal rows with
 * status pending/running, annotated with the instance that currently lists
 * their session so the client can address stop/resume correctly) and
 * `recentRuns` (the finished complement — the top-level completion list's
 * feed).
 *
 * Everything is best-effort per group: a failing workspace degrades to an
 * `error` group (the list must not blank out because one bridge is down),
 * and the whole call only rejects on a structural bug.
 */

import { get as httpGet } from "node:http";

import type { WorkflowScope } from "../settings/workflow.js";

/** The instance facts this module needs from the hub's registry. */
export interface OverviewInstance {
  id: string;
  port: number;
  workspace: string;
  startedAt: number;
  sessions: Array<{ sessionId: string; status?: "running" | "idle"; updatedAt?: number }>;
}

/** A journal run row (the bridge's `workflows/runs` shape, passthrough). */
export interface OverviewRunRow {
  runId?: string;
  name?: string;
  status?: string;
  updatedAt?: number;
  acpSessionId?: string;
  /** Injected here: the instance whose live session list holds this run. */
  ownerInstanceId?: string;
  [key: string]: unknown;
}

/** One list group — shape-compatible with the client's existing group model. */
export interface OverviewGroup {
  instanceId: string;
  scope: WorkflowScope;
  workspace: string;
  workflows: unknown[];
  invalid: unknown[];
  lastRuns: Record<string, OverviewRunRow>;
  error: string | null;
}

export interface WorkflowOverview {
  ok: true;
  groups: OverviewGroup[];
  activeRuns: OverviewRunRow[];
  /**
   * Recently finished runs (terminal statuses only, newest first, capped) —
   * the same machine-wide journal read activeRuns feeds, minus the live rows.
   * The completion list's home: without it a settled run only resurfaces two
   * taps deep (workflow card → per-name history).
   */
  recentRuns: OverviewRunRow[];
}

/** Per-read budget — these are loopback scans, not backend round-trips. */
const FETCH_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Journal window for the global read (upstream caps the limit at 50). */
const RUNS_LIMIT = 50;
/** Live-registry statuses — a run reporting either is flying right now. */
const LIVE_STATUSES = new Set(["running", "pending"]);
/** Served cap on the finished-run list (the journal read is capped at 50 anyway). */
const RECENT_RUNS_LIMIT = 20;

/** GET one bridge route, parsed as JSON. Rejects on transport/status/parse. */
function fetchBridgeJson(port: number, path: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = httpGet({ host: "127.0.0.1", port, path }, (up) => {
      if ((up.statusCode ?? 500) !== 200) {
        up.resume();
        reject(new Error(`bridge answered ${up.statusCode ?? "?"}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      up.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          up.destroy();
          reject(new Error("bridge answer too large"));
          return;
        }
        chunks.push(c);
      });
      up.on("end", () => {
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            reject(new Error("bridge answer is not an object"));
            return;
          }
          resolve(parsed as Record<string, unknown>);
        } catch {
          reject(new Error("bridge answer is not JSON"));
        }
      });
      up.on("error", reject);
    });
    req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error("bridge fetch timed out")));
    req.on("error", reject);
  });
}

interface PairResult {
  list: Record<string, unknown>;
  runs: OverviewRunRow[];
}

/**
 * One LIST+RUNS pair for a scope, read from one bridge in parallel: racing the
 * runs read separately lets the journal answer land before the list it belongs
 * to (the client-side bug this endpoint replaces did exactly that).
 */
async function fetchPair(inst: OverviewInstance, scope: WorkflowScope): Promise<PairResult> {
  const q = `?scope=${scope}&limit=${RUNS_LIMIT}`;
  const [list, runs] = await Promise.all([
    fetchBridgeJson(inst.port, `/settings/workflows${q}`),
    fetchBridgeJson(inst.port, `/settings/workflows/runs${q}`),
  ]);
  return {
    list,
    runs: Array.isArray(runs["runs"]) ? (runs["runs"] as OverviewRunRow[]) : [],
  };
}

/**
 * Ask every candidate bridge for the pair and keep the FRESHEST-started
 * success. Parallel on purpose: a dead/old bridge must not serialize the
 * workspaces that can answer. Undefined = every candidate failed (the caller
 * renders an error group / drops the global group).
 */
async function pickPair(
  candidates: OverviewInstance[],
  scope: WorkflowScope,
): Promise<{ inst: OverviewInstance; pair: PairResult } | undefined> {
  const results = await Promise.all(
    candidates.map(async (inst) => {
      try {
        return { inst, pair: await fetchPair(inst, scope) };
      } catch {
        return { inst };
      }
    }),
  );
  const winners = results.filter(
    (r): r is { inst: OverviewInstance; pair: PairResult } => "pair" in r,
  );
  if (winners.length === 0) return undefined;
  winners.sort((a, b) => b.inst.startedAt - a.inst.startedAt);
  return winners[0];
}

/** Per workflow NAME, the newest journal row (`updatedAt` desc) — the badge join. */
function lastRunByName(runs: OverviewRunRow[]): Record<string, OverviewRunRow> {
  const byName: Record<string, OverviewRunRow> = {};
  const sorted = [...runs].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  for (const r of sorted) {
    if (typeof r.name === "string" && r.name && !byName[r.name]) byName[r.name] = r;
  }
  return byName;
}

function workflowsOf(list: Record<string, unknown>): unknown[] {
  return Array.isArray(list["workflows"]) ? (list["workflows"] as unknown[]) : [];
}

function invalidOf(list: Record<string, unknown>): unknown[] {
  return Array.isArray(list["invalid"]) ? (list["invalid"] as unknown[]) : [];
}

/**
 * Annotate each run with the instance whose live session list currently holds
 * its joined ACP session — the address for stop/resume from a client attached
 * to a DIFFERENT instance. A session shown "running" on one instance wins;
 * otherwise the freshest-started holder. Rows no instance lists stay bare
 * (the client falls back to its own launch memory / current instance).
 */
function annotateOwners(rows: OverviewRunRow[], instances: OverviewInstance[]): void {
  for (const row of rows) {
    // The live-truth owner (set by applyLiveTruth from the instance whose
    // live registry reported the run) is process evidence, not a heuristic —
    // never overwrite it. The heuristic only fills rows it did not correct.
    if (row.ownerInstanceId) continue;
    const acpSid = row.acpSessionId;
    if (typeof acpSid !== "string" || !acpSid) continue;
    let best: OverviewInstance | undefined;
    let bestRunning = false;
    for (const inst of instances) {
      const mine = inst.sessions.find((s) => s.sessionId === acpSid);
      if (!mine) continue;
      const running = mine.status === "running";
      const better =
        best === undefined ||
        (running && !bestRunning) ||
        (running === bestRunning && inst.startedAt > best.startedAt);
      if (better) {
        best = inst;
        bestRunning = running;
      }
    }
    if (best) row.ownerInstanceId = best.id;
  }
}

/**
 * Live overrides for journal rows upstream may have wrongly declared dead.
 *
 * Why this exists: upstream's orphan reconciliation (`reconcileOrphanRuns`,
 * bootstrap.app — it runs at every app construction) assumes "no in-flight
 * run in MY process registry ⇒ every non-terminal row of this session is a
 * dead process's leftover" and writes stopped(interrupted) — even when the
 * run is still executing in ANOTHER process. Observed 2026-10-02: a second
 * process constructed the session at 11:44 and wrote the interrupted verdict
 * onto a run that kept dispatching sub-agents until it completed at 14:21;
 * the row never flips back mid-run, so the whole flight window rendered as
 * already-stopped. The owning process's live read
 * (`/settings/workflow-runs?sessionId=` → `v4/conversation/workflowRuns` →
 * `listRunsForSession`) overlays its live registry onto the journal — upstream
 * built it exactly so "this read would not show a run marked dead by a foreign
 * write" — and that overlay is the only trustworthy status here.
 *
 * Trigger = the reconciliation's signature alone (`stopReason:
 * "interrupted"`); no suspicious row → zero probes. Do NOT gate on the
 * instance showing the session as "running": a workflow keeps flying while its
 * parent session sits idle between turns (exactly how the observed run looked
 * for its last two hours), so a running-gated trigger misses the reported
 * case. When suspicious rows exist, probe the sessions the OWNER WORKSPACE's
 * instances list (any status), with each instance's OWN spelling — probing
 * what it reported to the hub keeps this a same-process read. The row's
 * `acpSessionId` is deliberately NOT used as the probe key: alias spellings
 * differ per bridge (one bridge's `sess_…` is another's backend id), and an id
 * a bridge never listed may still resolve through its durable alias store and
 * cold-resume the conversation — materializing a second runtime for a live
 * conversation, which scrambles the shared event log. The probe result joins
 * on runId (a run's stable identity), so one confirmation corrects the row in
 * every group that carries it.
 */
async function collectLiveOverrides(
  instances: OverviewInstance[],
  rows: OverviewRunRow[],
): Promise<Map<string, { status: string; instanceId: string }>> {
  const out = new Map<string, { status: string; instanceId: string }>();
  const suspicious = rows.filter(
    (r) =>
      r["stopReason"] === "interrupted" &&
      typeof r.runId === "string" &&
      r.runId !== "" &&
      typeof r.cwd === "string" &&
      r.cwd !== "",
  );
  if (suspicious.length === 0) return out;

  // The workspace is the ownership evidence: a run's cwd is where its session
  // lives, and the hub already groups instances by that same workspace string.
  const byWorkspace = new Map<string, OverviewInstance[]>();
  for (const inst of instances) {
    const list = byWorkspace.get(inst.workspace) ?? [];
    list.push(inst);
    byWorkspace.set(inst.workspace, list);
  }
  for (const list of byWorkspace.values()) list.sort((a, b) => b.startedAt - a.startedAt);

  /** Hard ceiling on live probes per build (never hit in practice). */
  const MAX_LIVE_PROBES = 24;
  const probes = new Map<string, Promise<Record<string, unknown> | undefined>>();
  const probe = (inst: OverviewInstance, sessionId: string) => {
    const key = `${inst.id}\u0000${sessionId}`;
    let p = probes.get(key);
    if (!p) {
      if (probes.size >= MAX_LIVE_PROBES) return Promise.resolve(undefined);
      p = fetchBridgeJson(
        inst.port,
        `/settings/workflow-runs?sessionId=${encodeURIComponent(sessionId)}`,
      ).catch(() => undefined);
      probes.set(key, p);
    }
    return p;
  };

  for (const row of suspicious) {
    const runId = row.runId as string;
    const candidates = byWorkspace.get(row.cwd as string) ?? [];
    outer: for (const inst of candidates) {
      // Running sessions first (most likely to hold a flying run), then the
      // freshest driving copy — the hub's own dedupe ranks bridges that way.
      const sessions = [...inst.sessions].sort(
        (a, b) =>
          (a.status === "running" ? 0 : 1) - (b.status === "running" ? 0 : 1) ||
          (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
      );
      for (const s of sessions) {
        const body = await probe(inst, s.sessionId);
        if (!body) continue; // dead / old bridge — next session or instance
        const runs = Array.isArray(body["runs"]) ? (body["runs"] as OverviewRunRow[]) : [];
        const match = runs.find((r) => r.runId === runId);
        if (!match) continue; // this process does not know the run
        if (typeof match.status === "string" && LIVE_STATUSES.has(match.status)) {
          out.set(runId, { status: match.status, instanceId: inst.id });
          break outer;
        }
        // Found terminal here — a sibling bridge may still hold the live
        // copy, so keep trying the rest of the workspace's sessions.
      }
    }
  }
  return out;
}

/**
 * Apply the live truth to a set of journal rows, in place: a row the live
 * registry reports flying loses the foreign "interrupted" verdict, and a row
 * with no owner gets the instance that actually reported it live (the address
 * for stop/detail from a client attached elsewhere).
 */
function applyLiveTruth(
  rows: OverviewRunRow[],
  liveRuns: Map<string, { status: string; instanceId: string }>,
): void {
  for (const row of rows) {
    const runId = typeof row.runId === "string" ? row.runId : "";
    if (!runId) continue;
    const live = liveRuns.get(runId);
    if (!live) continue;
    row.status = live.status;
    delete row["stopReason"];
    if (!row.ownerInstanceId) row.ownerInstanceId = live.instanceId;
  }
}

/**
 * Build the machine-level overview from the hub's instance snapshot.
 * Never throws for bridge-side failures — only for structural bugs.
 */
export async function buildWorkflowOverview(
  instances: OverviewInstance[],
): Promise<WorkflowOverview> {
  // One representative per workspace, freshest started first (the prefer
  // order pickPair consumes); every duplicate bridge is a retry candidate.
  const byWorkspace = new Map<string, OverviewInstance[]>();
  for (const inst of instances) {
    const list = byWorkspace.get(inst.workspace) ?? [];
    list.push(inst);
    byWorkspace.set(inst.workspace, list);
  }
  for (const list of byWorkspace.values()) list.sort((a, b) => b.startedAt - a.startedAt);

  const groups: OverviewGroup[] = [];

  // Global saved workflows + the machine-wide journal read ride ONE pair:
  // upstream's global runs read has no cwd filter, so its rows cover every
  // project (each row carrying `cwd`) — the active-run feed and the global
  // group's badges come from the same answer.
  const global = await pickPair(instances, "global");
  // Cross-check the global rows' reconciliation-signature verdicts against
  // the owner's live read (see collectLiveOverrides); the runId-keyed result
  // feeds every group carrying the same row.
  const liveOverrides = global
    ? await collectLiveOverrides(instances, global.pair.runs)
    : new Map<string, { status: string; instanceId: string }>();
  let activeRuns: OverviewRunRow[] = [];
  let recentRuns: OverviewRunRow[] = [];
  if (global) {
    applyLiveTruth(global.pair.runs, liveOverrides);
    groups.push({
      instanceId: global.inst.id,
      scope: "global",
      workspace: "",
      workflows: workflowsOf(global.pair.list),
      invalid: invalidOf(global.pair.list),
      lastRuns: lastRunByName(global.pair.runs),
      error: null,
    });
    activeRuns = global.pair.runs.filter(
      (r) => typeof r.status === "string" && LIVE_STATUSES.has(r.status),
    );
    annotateOwners(activeRuns, instances);
    // The finished complement, newest first — terminal rows only, so a
    // live-corrected row (applyLiveTruth above) lands in activeRuns, not here.
    recentRuns = global.pair.runs
      .filter((r) => typeof r.status === "string" && !LIVE_STATUSES.has(r.status))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, RECENT_RUNS_LIMIT);
    annotateOwners(recentRuns, instances);
  }

  // One project group per workspace, workspace-path order (stable across
  // refreshes — completion-order pushes reordered the sections client-side).
  const workspaces = [...byWorkspace.keys()].sort();
  const projectGroups = await Promise.all(
    workspaces.map(async (workspace): Promise<OverviewGroup> => {
      const candidates = byWorkspace.get(workspace)!;
      const picked = await pickPair(candidates, "project");
      if (!picked) {
        // Every bridge of this workspace failed — a group the client renders
        // as unavailable, still carrying the workspace label.
        return {
          instanceId: candidates[0]!.id,
          scope: "project",
          workspace,
          workflows: [],
          invalid: [],
          lastRuns: {},
          error: "no bridge of this workspace answered",
        };
      }
      await applyLiveTruth(picked.pair.runs, liveOverrides);
      return {
        instanceId: picked.inst.id,
        scope: "project",
        workspace,
        workflows: workflowsOf(picked.pair.list),
        invalid: invalidOf(picked.pair.list),
        lastRuns: lastRunByName(picked.pair.runs),
        error: null,
      };
    }),
  );
  groups.push(...projectGroups);

  return { ok: true, groups, activeRuns, recentRuns };
}
