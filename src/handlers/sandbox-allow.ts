/**
 * Sandbox dynamic-allow flow (ADR-0011).
 *
 * A write outside the Seatbelt whitelist fails inside the sandboxed backend
 * with "Operation not permitted" in the tool output. The bridge extracts the
 * denied path, asks the user via ACP `session/request_permission`
 * (仅此一次 / 始终允许 / 拒绝一次 / 始终拒绝), and on approval kills the backend so the next
 * ensureBackend() respawns under a widened profile. prompt() then chains the
 * continuation inside the original session/prompt request (see session.ts) so
 * the model resumes the interrupted task — per-command seamless escalation is impossible (the
 * executor lives inside the sandbox; profiles are immutable per process),
 * restart-batched granularity is the closest achievable form. Since
 * 2026-11-27 the ask target is the WORKSPACE ROOT for denials under a live
 * workspace (one ask per repo, not one per parent directory); the "始终"
 * choices persist there too — into that workspace's project config, else
 * into the machine-global file. Rejection stays fine-grained: declining a
 * root ask persists the originally denied PATH, never the root.
 */

import os from "node:os";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";

import {
  appendGlobalSandboxAllow,
  appendGlobalSandboxDeny,
  appendProjectSandboxAllow,
  appendProjectSandboxDeny,
  globalSandboxConfigDir,
  globalSandboxConfigPath,
  projectSandboxConfigPath,
  projectSandboxIslandPaths,
  readGlobalSandboxConfig,
  readProjectSandboxConfig,
  resolveReal,
} from "../backend/sandbox.js";
import { sandboxUnattendedAskTimeoutMs } from "../config/settings.js";
import { messages } from "../i18n.js";
import { log, warn } from "../utils.js";
import { hasActiveWorkflowRun } from "../workflow/poller.js";
import type { PendingTurn, ZcodeAcpServer } from "../server.js";
import { sendTextChunk } from "./io.js";
import { isInteractionInterrupted, requestWithTimeout } from "./server-requests.js";

/** A sandbox write-denial observed in tool output. */
export interface SandboxDenial {
  /** The absolute path the OS refused to write (as printed by the tool). */
  path: string;
  /** mkdir-style failures target a directory that does not exist yet — the
   *  path itself is the directory to allow, not its parent. */
  isMkdir: boolean;
}

const EPERM = "Operation not permitted";

/** Sentinel for the path-less generic hint's per-session dedup. */
export const GENERIC_HINT_KEY = "(generic)";

/**
 * Tools whose output merely ECHOES text — an EPERM string in their output
 * (docs, source, failing-test literals) is not their own syscall failing,
 * and acting on it would raise a phantom ask. Lowercase: the backend
 * reports both "Read" and "read" forms. Unknown names (MCP tools) stay
 * scanned — a custom tool can legitimately hit the sandbox.
 */
export const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "webfetch",
  "websearch",
  "todoread",
  "todowrite",
  "enterplanmode",
  "exitplanmode",
  "askuserquestion",
]);

/**
 * Extract the denied path from tool output text (pure; exported for tests).
 * Handles the POSIX tool form (`rm: /a/b: Operation not permitted`), the zsh
 * redirect form (`zsh:2: operation not permitted: /a/b` — lowercase, path
 * AFTER the phrase, the shape every shell redirect denial actually prints),
 * and the Node fs form (`EPERM: operation not permitted, open '/a/b'`).
 * Explicit `./` and `../` relative paths are extracted too and resolved
 * against the session cwd by handleSandboxDenial; bare `foo/bar:` fragments
 * are deliberately not matched. Paths containing spaces or quotes are not
 * matched — the ask falls back to a generic hint.
 */
export function extractSandboxDenial(text: string): SandboxDenial | null {
  if (!text.toLowerCase().includes(EPERM.toLowerCase())) return null;
  const mkdirMatch = /mkdir: ((?:\/|\.{1,2}\/)[^\s"\\:]+): /i.exec(text);
  if (mkdirMatch) return { path: mkdirMatch[1]!, isMkdir: true };
  // Anchor the path to a boundary (start, whitespace, quote, bracket) so a
  // RELATIVE path fragment ("relative/x: …") is not mistaken for absolute.
  const generic = /(?:^|[\s"([{])((?:\/|\.{1,2}\/)[^\s"\\:]+): operation not permitted/i.exec(text);
  if (generic) return { path: generic[1]!, isMkdir: false };
  // Node fs errors quote the path, so spaces survive this form. Any libuv
  // syscall name matches (open/rename/unlink/mkdtemp/... — they all print
  // alike); the closing quote must END the token (?![\w/]) so an apostrophe
  // inside the path ("O'Brien") falls back to the generic hint instead of
  // truncating the match into a much broader directory.
  const nodeForm = /operation not permitted, ([a-z]+) '([^']+)'(?![\w/])/i.exec(text);
  if (nodeForm) return { path: nodeForm[2]!, isMkdir: nodeForm[1]!.toLowerCase() === "mkdir" };
  // zsh redirect form: path trails the phrase (`zsh:2: operation not permitted: /a/b`).
  const zsh = /operation not permitted: ((?:\/|\.{1,2}\/)[^\s"\\:]+)/i.exec(text);
  if (!zsh) return null;
  return { path: zsh[1]!, isMkdir: false };
}

/**
 * How long approvals collect into one restart batch (ADR-0011). The old flow
 * restarted the backend on EVERY approval; a second popup still pending on
 * another denied path was killed by that restart and — worse — its debounce
 * mark permanently muted the re-ask, so the model kept hitting a bare EPERM
 * with no way out. Approvals inside one window now share a single restart
 * and continuation.
 */
export const SANDBOX_RESTART_BATCH_MS = 3000;

/**
 * Cooldown before a FAILED ask (timeout, dead channel, killed by another
 * grant's restart) may re-ask the same path. No cooldown at all would storm
 * on instantly-rejecting clients; the old permanent mute left the model
 * hitting a bare EPERM with no way out. A USER decision pins the path
 * forever instead (see handleSandboxDenial).
 */
const SANDBOX_ASK_RETRY_MS = 60_000;
export { SANDBOX_ASK_RETRY_MS };

/**
 * Asked-map mark for a path an unattended-context ask timed out on. Unlike a
 * user decision (Infinity) it is NOT permanent: the mark is re-checked
 * lazily, and once the unattended context is over (goal loop stopped /
 * workflow run settled) the path may ask again — the pin exists to stop
 * popup/push storms while nobody can answer, not to decide for the user.
 */
export const UNATTENDED_PIN = -1;

/**
 * Is this session currently in an unattended context — a chain that must not
 * block on a human answer? Goal-loop rounds (turn.goalLoop) and sessions
 * with an in-flight workflow run (the parent must stay able to receive
 * results and steer the run). "No client connected" is NOT this: that is the
 * hold case, which still waits for the user to come back.
 */
export function sessionUnattended(server: ZcodeAcpServer, acpSid: string): boolean {
  const z = server.resolveSid(acpSid);
  if (z === undefined) return false;
  if (server.goalLoops.has(z)) return true;
  return hasActiveWorkflowRun(z);
}

/**
 * End the frozen turn so the task resumes with the denial context instead of
 * the model free-running past the EPERM it caused. The turn unwinds as
 * `cancelled`; an ordinary (prompt()-driven) round gets a continuation the
 * chained round consumes; a goal-loop round gets the sandboxRestart mark so
 * the driver re-dispatches the ticket instead of pausing like a user ESC.
 */
function settleDeniedTurn(
  server: ZcodeAcpServer,
  acpSid: string,
  turn: PendingTurn | undefined,
  continuationText: string,
): void {
  if (!turn) return;
  turn.cancelled = true;
  if (turn.goalLoop) {
    turn.sandboxRestart = true;
  } else {
    server.sandboxContinuations.set(acpSid, continuationText);
  }
}

/**
 * Collects approved grants and fires ONE flush per batch window. Kept here
 * (not in server.ts) so tests drive the batching against a stub flush
 * without constructing a whole ZcodeAcpServer.
 */
export class SandboxRestartBatcher {
  private readonly grants = new Map<string, string[]>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly flush: (grants: Map<string, string[]>) => void,
    private readonly batchMs: number = SANDBOX_RESTART_BATCH_MS,
  ) {}

  /** Add one approved path for a session; the first add arms the window. */
  add(acpSid: string, grantedReal: string): void {
    const list = this.grants.get(acpSid) ?? [];
    if (!list.includes(grantedReal)) list.push(grantedReal);
    this.grants.set(acpSid, list);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.grants.size === 0) return;
      const batch = new Map(this.grants);
      this.grants.clear();
      this.flush(batch);
    }, this.batchMs);
    this.timer.unref?.();
  }

  /** Does this session still have a grant collecting in the open window? */
  pendingFor(acpSid: string): boolean {
    return this.grants.has(acpSid);
  }
}

/**
 * Block until this session's batched grant flushes (the window closes and the
 * cancel-wave + continuation land). Called by the turn loop right after an
 * allow settles: the freeze's stop already produced a terminal event in the
 * backlog, and processing it before the flush would end the round end_turn —
 * dropping it from pendingTurns so the flush finds no in-flight turn and the
 * continuation (and with it the whole grant) would be orphaned. Bounded: a
 * stuck flush degrades to the old behaviour instead of hanging the turn.
 */
export async function waitForSandboxBatchFlush(
  server: ZcodeAcpServer,
  acpSid: string,
  maxMs: number = SANDBOX_RESTART_BATCH_MS + 2_000,
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (server.sandboxRestartBatcher.pendingFor(acpSid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * What flushSandboxGrants needs from the server (satisfied structurally by
 * ZcodeAcpServer; tests stub it). Keeping the flush standalone makes the
 * cancel-wave / continuation / kill sequencing unit-testable without a
 * whole server.
 */
export interface SandboxFlushTarget {
  cancelAllPendingTurns(): void;
  readonly sandboxContinuations: Map<string, string>;
  /** acpSid → live zcode session id. */
  readonly sessionMap: Map<string, string>;
  /** In-flight turns; entries are deleted when the turn's prompt returns. */
  readonly pendingTurns: Map<
    number | string,
    { zcodeSid: string; cancelled?: boolean; goalLoop?: boolean; sandboxRestart?: boolean }
  >;
  /** The backend to close; the flush nulls it (respawn stays lazy). */
  backend: { close(): Promise<void>; readonly isDead: boolean } | null;
}

/**
 * One batched sandbox allow-restart (ADR-0011; driven by
 * SandboxRestartBatcher): cancel every in-flight turn — they share the
 * backend and would otherwise hang on the dead reader — queue one
 * continuation per session listing ALL granted paths, and close the backend
 * once. The next ensureBackend() respawns under the widened profile
 * (persisted config entries + bridge-lifetime once-allows).
 */
export function flushSandboxGrants(
  target: SandboxFlushTarget,
  grants: Map<string, string[]>,
): void {
  const m = messages();
  const count = [...grants.values()].reduce((n, ps) => n + ps.length, 0);
  // Goal-loop rounds (ADR-0022) are still cancelled — the backend restart
  // kills their generation too — but MARKED so the driver re-dispatches the
  // ticket instead of pausing like a user ESC, and never fed a continuation:
  // prompt() is not driving those turns, so an entry would be orphaned and
  // later hijack an unrelated cancelled prompt.
  for (const t of target.pendingTurns.values()) {
    // An already-cancelled turn was stopped by someone else first (user ESC —
    // the turn loop polls the flag on a ~100ms cadence); reinterpreting that
    // as a restart would make the driver re-dispatch instead of pausing.
    if (t.goalLoop && !t.cancelled) t.sandboxRestart = true;
  }
  target.cancelAllPendingTurns();
  // Continuations ONLY for sessions with an in-flight EDITOR turn: those turn
  // loops unwind on the cancelled flag and prompt() consumes the
  // continuation as it returns. A session whose turn already finished
  // naturally during the batch window (or whose only turn was a goal round)
  // has nobody to consume the entry — an orphan would later hijack an
  // UNRELATED cancelled prompt (ESC, preempt, drain gate) into an automatic
  // "continue" round.
  const liveZcode = new Set<string>();
  for (const t of target.pendingTurns.values()) {
    if (!t.goalLoop) liveZcode.add(t.zcodeSid);
  }
  for (const [sid, paths] of grants) {
    const z = target.sessionMap.get(sid);
    if (z !== undefined && liveZcode.has(z)) {
      target.sandboxContinuations.set(sid, m.sandboxContinuationPrompt(paths));
    } else {
      log(`sandbox: no in-flight turn — ${paths.length} grant(s) apply on next spawn`);
    }
  }
  const dying = target.backend;
  if (!dying || dying.isDead) {
    // Already gone (e.g. a late approval after an earlier batch restarted):
    // the grants live in the config / once-allows, and the next
    // ensureBackend() spawns with them — respawning here just to close the
    // new process again would churn.
    log(`sandbox: backend already gone — ${count} grant(s) apply on next spawn`);
    return;
  }
  // Drop the reference BEFORE the async kill: the turn loops unwind on the
  // cancelled flag while the kill is still in flight, and prompt()'s
  // continuation round reaches ensureBackend() the moment its first round
  // returns — with the old reference still held it would adopt the dying
  // backend instead of respawning under the widened profile.
  target.backend = null;
  log(`sandbox: restarting backend with ${count} granted path(s)`);
  dying
    .close()
    .catch((e: unknown) =>
      warn(`sandbox: backend kill failed: ${e instanceof Error ? e.message : String(e)}`),
    );
}

/**
 * Extract the path from an ordinary filesystem-permission failure (EACCES —
 * "Permission denied"), as printed by POSIX tools (`ls: /a/b: Permission
 * denied`) and zsh redirects (`zsh:1: permission denied: /a/b`). Unlike a
 * sandbox EPERM the bridge can never "allow" this — no popup fixes chmod or
 * ownership — so the turn loop surfaces it as a one-time hint instead of
 * raising an ask. Same boundary rules as extractSandboxDenial: explicit ./
 * and ../ relative paths are returned as-is (resolved by the caller), bare
 * relative fragments and quoted paths are not matched.
 */
export function extractPermDeniedPath(text: string): string | null {
  if (!text.toLowerCase().includes("permission denied")) return null;
  const generic = /(?:^|[\s"([{])((?:\/|\.{1,2}\/)[^\s"\\:]+): permission denied/i.exec(text);
  if (generic) return generic[1]!;
  const zsh = /permission denied: ((?:\/|\.{1,2}\/)[^\s"\\:]+)/i.exec(text);
  return zsh ? zsh[1]! : null;
}

/**
 * Paths that no popup can ever allow: the global config dir and every
 * workspace's `.zcode/acp/` island (config self-edit = self-escalation) and
 * strictGit's .git — their denies are emitted LAST in the profile (SBPL
 * last-match), so an allow line can never override them. Offering the popup
 * there would just white-flash and dead-end.
 */
export function protectedSandboxPaths(cwdRoots: Iterable<string>): string[] {
  const roots = [...cwdRoots];
  const out = [globalSandboxConfigDir()];
  for (const root of roots) out.push(...projectSandboxIslandPaths(root));
  // The profile ORs strictGit across both config layers and then denies
  // EVERY root's .git — mirror that here, or a project-only strictGit would
  // raise a popup no grant can ever satisfy.
  const strictGit =
    readGlobalSandboxConfig().strictGit ||
    roots.some((root) => readProjectSandboxConfig(root)?.strictGit === true);
  if (strictGit) {
    for (const root of roots) out.push(path.join(resolveReal(root), ".git"));
  }
  return out;
}

/** Is `target` at or under one of the protected (unallowable) paths? */
function underAny(target: string, bases: string[]): boolean {
  // macOS filesystems are case-insensitive: Seatbelt denies `.ZCODE/ACP`
  // like `.zcode/acp`, so this check must fold case too — a case variant
  // would otherwise get a popup that can never override the deny.
  const fold = process.platform === "darwin";
  const t = fold ? target.toLowerCase() : target;
  return bases.some((b) => {
    const base = fold ? b.toLowerCase() : b;
    return t === base || t.startsWith(base + path.sep);
  });
}

/**
 * Ask the user to allow the directory behind a sandbox denial and, on
 * approval, queue the grant into the batched restart (see
 * SandboxRestartBatcher — one restart per window, not one per approval).
 * The EPERM tool result has already reached the model, so a REAL ask first
 * FREEZES the backend's generation (the stop pair — the model must not work
 * past the denial it caused while the user is being asked); the turn then
 * unwinds as cancelled and resumes via the continuation machinery on every
 * outcome (allow → widened-profile respawn; rejection/timeout → same
 * backend, denial context in the continuation). Best-effort: any failure
 * keeps the sandbox exactly as it was.
 */
export async function handleSandboxDenial(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  denial: SandboxDenial,
  toolCallId: string,
  turn?: PendingTurn,
  freeze?: (turn: PendingTurn) => Promise<void>,
): Promise<void> {
  // Process-level fact, not the config wish: the caller gates on the same
  // flag, so a sandbox armed only via project config (no env) still flows.
  if (!server.backendSandboxed) return;
  const m = messages();
  // The shell printed the path relative to the SESSION cwd — resolve against
  // that, not the bridge's own cwd (they differ for remote/hub clients).
  const raw = denial.isMkdir ? denial.path : path.dirname(denial.path);
  const cwd = server.sessionCwds.get(acpSid);
  const toReal = (p: string): string =>
    resolveReal(path.isAbsolute(p) ? p : path.resolve(cwd ?? process.cwd(), p));
  const rawTargetReal = toReal(raw);
  const deniedReal = toReal(denial.path);
  // Retarget (2026-11-27): a denial INSIDE a live workspace asks once for
  // the workspace root — the per-parent-dir target re-asked for every
  // sibling directory of one repo. Outside any root the parent-dir target
  // stays (toolchain/cache grants keep their tight granularity). Longest
  // root first, so nested live workspaces resolve to the inner one.
  const roots = [...server.sandboxRoots()].map(resolveReal).sort((a, b) => b.length - a.length);
  let targetReal = rawTargetReal;
  const rootReal =
    roots.find((r) => rawTargetReal === r || rawTargetReal.startsWith(r + path.sep)) ?? null;
  // The config file an "always" decision about this workspace persists to.
  const configFile = rootReal ? projectSandboxConfigPath(rootReal) : globalSandboxConfigPath();

  // Debounce marks: one ask per path per session. The mark carries the ask
  // timestamp — a USER decision pins it forever (Infinity); an ask that died
  // of the environment merely cools down for SANDBOX_ASK_RETRY_MS and may
  // re-ask afterwards; an unattended timeout pins for the REST of its
  // unattended context (lazily re-checked — see UNATTENDED_PIN). Keyed on
  // the (possibly retargeted) ask target.
  let asked = server.sandboxAskedPaths.get(acpSid);
  if (!asked) {
    asked = new Map();
    server.sandboxAskedPaths.set(acpSid, asked);
  }

  // Unallowable by construction (their denies win the last-match): the
  // global config dir, each root's config island, strictGit's .git. Vetted on
  // the DENIED PATH and on its ask target, before any retarget — tell the
  // USER why instead of a doomed popup; the model only ever sees the bare
  // EPERM in its tool output. Structural: hinted once per session, then
  // silent (the pin below is what makes repeats quiet).
  const protectedPaths = protectedSandboxPaths(server.sandboxRoots());
  if (underAny(deniedReal, protectedPaths) || underAny(rawTargetReal, protectedPaths)) {
    if (asked.get(rawTargetReal) === Number.POSITIVE_INFINITY) return;
    asked.set(rawTargetReal, Number.POSITIVE_INFINITY);
    await sendTextChunk(cx, acpSid, m.sandboxProtectedHint, randomUUID());
    return;
  }

  // A persisted "永不放行" decision — VISIBLE config, never hidden bridge
  // memory: no popup, and the asked-mark keeps later repeats silent. Checked
  // in BOTH layers — the global file and EVERY live workspace's project
  // file, exactly the union the profile denies — at the raw path, so a
  // deny-listed path is never smuggled into a root-wide ask. The hint names
  // the file that actually holds the entry.
  const denyListedInRoot =
    roots.find((r) =>
      underAny(rawTargetReal, (readProjectSandboxConfig(r)?.deny ?? []).map(resolveReal)),
    ) ?? null;
  if (
    denyListedInRoot ||
    underAny(rawTargetReal, readGlobalSandboxConfig().deny.map(resolveReal))
  ) {
    if (asked.get(rawTargetReal) === Number.POSITIVE_INFINITY) return;
    asked.set(rawTargetReal, Number.POSITIVE_INFINITY);
    await sendTextChunk(
      cx,
      acpSid,
      m.sandboxDenyListedHint(
        rawTargetReal,
        denyListedInRoot ? projectSandboxConfigPath(denyListedInRoot) : globalSandboxConfigPath(),
      ),
      randomUUID(),
    );
    return;
  }

  if (rootReal) targetReal = rootReal;

  const prior = asked.get(targetReal);
  if (prior === Number.POSITIVE_INFINITY) {
    return;
  }
  if (prior === UNATTENDED_PIN) {
    if (sessionUnattended(server, acpSid)) return;
    // The unattended context ended — the pin expires, ask afresh.
  } else if (prior !== undefined && Date.now() - prior < SANDBOX_ASK_RETRY_MS) {
    return;
  }
  asked.set(targetReal, Date.now());

  // Phantom-ask guard: echoed EPERM text can also extract a path no syscall
  // ever tried to write — and a grant for $HOME (or any of its ancestors)
  // would effectively gut the sandbox. Applied to the FINAL grant target (a
  // workspace rooted at $HOME retargets to exactly that). Such asks are
  // refused; hand-editing the config is the only way to grant something this
  // broad.
  const home = resolveReal(os.homedir());
  if (targetReal === "/" || targetReal === home || home.startsWith(targetReal + path.sep)) {
    asked.set(targetReal, Number.POSITIVE_INFINITY);
    await sendTextChunk(cx, acpSid, m.sandboxOverBroadHint(targetReal), randomUUID());
    return;
  }

  // A real ask is about to go out: FREEZE the backend's generation first.
  // The EPERM result already reached the model and it is free-running past
  // the denial while the user is being asked — the observed "the model kept
  // working / started the next round before the grant landed". The stop pair
  // does not touch turn.cancelled (that flag is only set below, once the ask
  // settles), so the ask's own cancel-poll racer stays quiet. Frozen output
  // after the stop is residue for the turn-attribution gate, same as a user
  // ESC.
  if (turn && freeze) {
    try {
      await freeze(turn);
    } catch (e) {
      warn(
        `sandbox: freeze before ask failed (asking anyway): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Unattended contexts (goal-loop round, workflow-run parent) must not block
  // on a human: their asks get a finite timeout and end no-decision — pin the
  // path for the rest of the context and resume with denial context. 0 (or
  // the file/env knob set to 0) = wait forever even unattended.
  const unattended = sessionUnattended(server, acpSid);
  const timeoutMs = unattended ? sandboxUnattendedAskTimeoutMs() : 0;

  const options = [
    {
      optionId: "sandbox_allow_always",
      kind: "allow_always" as const,
      name: m.sandboxOptionAllowAlways,
    },
    { optionId: "sandbox_allow_once", kind: "allow_once" as const, name: m.sandboxOptionAllowOnce },
    {
      optionId: "sandbox_reject_once",
      kind: "reject_once" as const,
      name: m.sandboxOptionRejectOnce,
    },
    {
      optionId: "sandbox_reject_always",
      kind: "reject_always" as const,
      name: m.sandboxOptionRejectAlways,
    },
  ];
  let decision: "always" | "once" | "reject_once" | "reject_always" | "deny" = "deny";
  // §6 funnel (requestWithTimeout), not a bare cx.request with a 120s cap:
  // the ask must HOLD while nobody can answer (zero clients at fire time, or
  // every connection dying mid-wait — the phone-sleep case) and
  // resendPendingInteractions re-fires it at the next client attach; the
  // watchdog/ask_settled bookkeeping comes with the funnel. Attended asks
  // have NO finite timeout — the escapes are the answer and the turn being
  // cancelled; unattended asks add the configured timeout (timeoutMs above).
  // Wire name is session/request_permission (snake_case — the camelCase
  // form is silently method-not-found on real clients). The schema has no
  // top-level title: the popup's DETAILS live on the toolCall update — its
  // title names the denied path and the text content explains the stakes.
  const resp = await requestWithTimeout(
    server,
    cx,
    "session/request_permission",
    {
      sessionId: acpSid,
      toolCall: {
        toolCallId,
        title: m.sandboxPopupTitle(targetReal),
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: m.sandboxPopupDetails(targetReal, configFile),
            },
          },
        ],
        rawInput: { path: targetReal },
      },
      options,
    },
    `sandbox allow ${targetReal}`,
    timeoutMs,
    turn,
  );
  if (resp === null || isInteractionInterrupted(resp)) {
    if (turn?.cancelled) {
      // The turn was cancelled out from under the ask (user stop/preempt, or
      // ANOTHER grant's batched restart): the turn loop unwinds on its own
      // and prompt()/the driver consume the flush's continuation — settle
      // nothing here, a denial continuation would overwrite that grant's.
      warn(`sandbox: allow ask for ${targetReal} aborted (turn cancelled)`);
      return;
    }
    if (isInteractionInterrupted(resp) && unattended) {
      // Unattended timeout: no-decision, but the chain must keep moving —
      // pin the path for the rest of this context (no popup/push storm) and
      // resume the frozen turn with the denial context.
      asked.set(targetReal, UNATTENDED_PIN);
      settleDeniedTurn(server, acpSid, turn, m.sandboxUnattendedTimeoutContinuation(targetReal));
      await sendTextChunk(cx, acpSid, m.sandboxUnattendedTimeoutHint(targetReal), randomUUID());
      log(`sandbox: unattended ask for ${targetReal} timed out — denied for this context`);
      return;
    }
    // No user decision (client error / dead attempt with other clients
    // around). A frozen turn must still settle here: the stop already killed
    // the generation and nothing will re-trigger the EPERM, so without a
    // continuation the round would strand on the stop's half reply. This is
    // NOT a rejection — nothing is persisted or pinned; the asked-mark keeps
    // its timestamp, so the path merely cools down (SANDBOX_ASK_RETRY_MS) and
    // may re-ask afterwards — never permanently muted, never free to storm.
    if (turn) {
      settleDeniedTurn(server, acpSid, turn, m.sandboxAskUndeliveredContinuation(targetReal));
      await sendTextChunk(cx, acpSid, m.sandboxAskUndeliveredHint(targetReal), randomUUID());
    }
    warn(`sandbox: allow ask for ${targetReal} ended without a decision — may re-ask later`);
    return;
  }
  const oid = (resp as { outcome?: { optionId?: string } } | undefined)?.outcome?.optionId ?? "";
  if (oid === "sandbox_allow_always") decision = "always";
  else if (oid === "sandbox_allow_once") decision = "once";
  else if (oid === "sandbox_reject_always") decision = "reject_always";
  else if (oid === "sandbox_reject_once") decision = "reject_once";

  // A real outcome reached the client and came back (including an unknown
  // optionId the user picked): the user SAW this ask — pin the debounce
  // forever, whatever they chose.
  asked.set(targetReal, Number.POSITIVE_INFINITY);

  if (decision === "reject_always") {
    // The user's denial is persisted VISIBLY into config — never silently
    // remembered in bridge memory. Under a workspace root it lands in THAT
    // workspace's project file; the PATH persisted is the originally denied
    // one (rawTargetReal), never the retargeted root. And when that path IS
    // the root (a denial sitting directly under it, or a mkdir-style one on
    // the root itself), it goes to the GLOBAL deny list instead: a project
    // deny is a real SBPL deny in the last-match tail, so a root-wide entry
    // would lock every write in the repo after the next respawn, while the
    // global list only silences the popup. If the config can't be written,
    // nothing is stored: the ask simply resurfaces next time.
    const toProjectFile = rootReal !== null && rawTargetReal !== rootReal;
    const persisted = toProjectFile
      ? appendProjectSandboxDeny(rootReal, rawTargetReal)
      : appendGlobalSandboxDeny(rawTargetReal);
    // The turn was frozen for this ask — resume it with the denial context
    // (the model only saw a bare EPERM; without this it free-runs into
    // retrying the same path).
    settleDeniedTurn(server, acpSid, turn, m.sandboxRejectContinuation(targetReal));
    await sendTextChunk(
      cx,
      acpSid,
      persisted
        ? m.sandboxRejectAlwaysPersisted(
            rawTargetReal,
            toProjectFile ? configFile : globalSandboxConfigPath(),
          )
        : m.sandboxRejectAlwaysUnpersisted(targetReal),
      randomUUID(),
    );
    return;
  }

  if (decision === "reject_once" || decision === "deny") {
    settleDeniedTurn(server, acpSid, turn, m.sandboxRejectContinuation(targetReal));
    await sendTextChunk(cx, acpSid, m.sandboxRejectOnceHint(targetReal), randomUUID());
    return;
  }

  if (decision === "always") {
    // Persist where the grant applies (2026-11-27): under a workspace root
    // into THAT workspace's project config (targetReal IS the root after the
    // retarget), else into the machine-global file. The bridge writes these
    // files from OUTSIDE the sandbox (the config dir is denied in every
    // profile, so the agent cannot edit its own allowlist). An unparseable
    // or unwritable file downgrades to a bridge-lifetime once-allow.
    const persisted = rootReal
      ? appendProjectSandboxAllow(rootReal, targetReal)
      : appendGlobalSandboxAllow(targetReal);
    if (!persisted) server.sandboxOnceAllows.add(targetReal);
  } else {
    server.sandboxOnceAllows.add(targetReal);
  }

  // Arm the BATCHED restart: this grant joins the current window; the flush
  // (see SandboxRestartBatcher) cancels every pending turn, queues a
  // continuation per session listing ALL granted paths, and closes the
  // backend once (next ensureBackend() respawns with the widened profile —
  // once-allows and the persisted config are both folded in).
  server.sandboxRestartBatcher.add(acpSid, targetReal);
  await sendTextChunk(cx, acpSid, m.sandboxRestartHint(targetReal), randomUUID());
  log(`sandbox: allow granted for ${targetReal} (${decision}) — restart batched`);
}
