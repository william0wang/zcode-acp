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
 * directory-granularity with a restart is the closest achievable form.
 */

import os from "node:os";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";

import {
  appendSandboxAllow,
  appendSandboxDeny,
  collectSandboxWorkspaces,
  readSandboxConfig,
  resolveReal,
} from "../backend/sandbox.js";
import { messages } from "../i18n.js";
import { log, warn } from "../utils.js";
import type { ZcodeAcpServer } from "../server.js";
import { sendTextChunk } from "./io.js";

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

/** How long the allow popup may hang before it counts as a rejection. */
const ASK_TIMEOUT_MS = 120_000;

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
  readonly pendingTurns: Map<number | string, { zcodeSid: string }>;
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
  target.cancelAllPendingTurns();
  // Continuations ONLY for sessions with a turn still in flight: those turn
  // loops unwind on the cancelled flag and prompt() consumes the
  // continuation as it returns. A session whose turn already finished
  // naturally during the batch window has nobody to consume the entry — an
  // orphan would later hijack an UNRELATED cancelled prompt (ESC, preempt,
  // drain gate) into an automatic "continue" round.
  const liveZcode = new Set<string>();
  for (const t of target.pendingTurns.values()) liveZcode.add(t.zcodeSid);
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

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("sandbox ask timed out")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Paths that no popup can ever allow: the deny island (config self-edit =
 * self-escalation) and strictGit's .git — their denies are emitted LAST in
 * the profile (SBPL last-match), so an allow line can never override them.
 * Offering the popup there would just white-flash and dead-end.
 */
export function protectedSandboxPaths(cwdRoots: Iterable<string>): string[] {
  const { workspaces } = collectSandboxWorkspaces(cwdRoots);
  const out: string[] = [];
  for (const ws of workspaces) {
    out.push(path.join(ws.root, ".zcode", "acp"));
    if (ws.config.strictGit) out.push(path.join(ws.root, ".git"));
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
 * Best-effort: any failure keeps the sandbox exactly as it was.
 */
export async function handleSandboxDenial(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  denial: SandboxDenial,
  toolCallId: string,
): Promise<void> {
  // Process-level fact, not the config wish: the caller gates on the same
  // flag, so a sandbox armed only via project config (no env) still flows.
  if (!server.backendSandboxed) return;
  const m = messages();
  // The shell printed the path relative to the SESSION cwd — resolve against
  // that, not the bridge's own cwd (they differ for remote/hub clients).
  const raw = denial.isMkdir ? denial.path : path.dirname(denial.path);
  const cwd = server.sessionCwds.get(acpSid);
  const wsRoot = cwd;
  const targetReal = resolveReal(
    path.isAbsolute(raw) ? raw : path.resolve(cwd ?? process.cwd(), raw),
  );

  // Debounce: one ask per path per session. The mark carries the ask
  // timestamp — a USER decision pins it forever (Infinity); an ask that died
  // of the environment merely cools down for SANDBOX_ASK_RETRY_MS and may
  // re-ask afterwards.
  let asked = server.sandboxAskedPaths.get(acpSid);
  if (!asked) {
    asked = new Map();
    server.sandboxAskedPaths.set(acpSid, asked);
  }
  const prior = asked.get(targetReal);
  if (
    prior !== undefined &&
    (prior === Number.POSITIVE_INFINITY || Date.now() - prior < SANDBOX_ASK_RETRY_MS)
  ) {
    return;
  }
  asked.set(targetReal, Date.now());

  // Island / strictGit denials are unallowable by construction (their denies
  // win the last-match). Tell the USER why instead of a doomed popup — the
  // model only ever sees the bare EPERM in its tool output. Structural:
  // hinted once, pinned forever.
  if (underAny(targetReal, protectedSandboxPaths(server.sandboxRoots()))) {
    asked.set(targetReal, Number.POSITIVE_INFINITY);
    await sendTextChunk(cx, acpSid, m.sandboxProtectedHint, randomUUID());
    return;
  }

  // Phantom-ask guard: echoed EPERM text can also extract a path no syscall
  // ever tried to write — and a grant for $HOME (or any of its ancestors)
  // would effectively gut the sandbox. Such asks are refused; hand-editing
  // the config is the only way to grant something this broad.
  const home = resolveReal(os.homedir());
  if (targetReal === "/" || targetReal === home || home.startsWith(targetReal + path.sep)) {
    asked.set(targetReal, Number.POSITIVE_INFINITY);
    await sendTextChunk(cx, acpSid, m.sandboxOverBroadHint(targetReal), randomUUID());
    return;
  }

  // A persisted "永不放行" decision — VISIBLE config, never hidden bridge
  // memory: no popup, and the asked-mark above keeps later repeats silent.
  if (wsRoot && underAny(targetReal, readSandboxConfig(wsRoot).deny.map(resolveReal))) {
    asked.set(targetReal, Number.POSITIVE_INFINITY);
    await sendTextChunk(cx, acpSid, m.sandboxDenyListedHint(targetReal), randomUUID());
    return;
  }

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
  try {
    // Wire name is session/request_permission (snake_case — the camelCase
    // form is silently method-not-found on real clients). The schema has no
    // top-level title: the popup's DETAILS live on the toolCall update — its
    // title names the denied path and the text content explains the stakes.
    // No `as never`: tsc validates the wire shape against the SDK schema.
    const resp = (await withTimeout(
      cx.request("session/request_permission", {
        sessionId: acpSid,
        toolCall: {
          toolCallId,
          title: m.sandboxPopupTitle(targetReal),
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: m.sandboxPopupDetails(targetReal),
              },
            },
          ],
          rawInput: { path: targetReal },
        },
        options,
      }),
      ASK_TIMEOUT_MS,
    )) as { outcome?: { optionId?: string } } | undefined;
    const oid = resp?.outcome?.optionId ?? "";
    if (oid === "sandbox_allow_always") decision = "always";
    else if (oid === "sandbox_allow_once") decision = "once";
    else if (oid === "sandbox_reject_always") decision = "reject_always";
    else if (oid === "sandbox_reject_once") decision = "reject_once";
  } catch (e) {
    // Popup failed/timed out or the client channel died — including a kill
    // by ANOTHER grant's batched restart. This ask never got a user
    // decision; the timestamp stays as-is, so the path merely cools down
    // (SANDBOX_ASK_RETRY_MS) and may re-ask afterwards — never permanently
    // muted, never free to storm.
    warn(
      `sandbox: allow ask for ${targetReal} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }

  // A real outcome reached the client and came back (including an unknown
  // optionId the user picked): the user SAW this ask — pin the debounce
  // forever, whatever they chose.
  asked.set(targetReal, Number.POSITIVE_INFINITY);

  if (decision === "reject_always") {
    // The user's denial is persisted VISIBLY into the project config — never
    // silently remembered in bridge memory. If the config can't be written,
    // nothing is stored: the ask simply resurfaces next time.
    const persisted = wsRoot ? appendSandboxDeny(wsRoot, targetReal) : false;
    await sendTextChunk(
      cx,
      acpSid,
      persisted
        ? m.sandboxRejectAlwaysPersisted(targetReal)
        : m.sandboxRejectAlwaysUnpersisted(targetReal),
      randomUUID(),
    );
    return;
  }

  if (decision === "reject_once" || decision === "deny") {
    await sendTextChunk(cx, acpSid, m.sandboxRejectOnceHint(targetReal), randomUUID());
    return;
  }

  if (decision === "always") {
    // Persist into the session's project config — the bridge writes this
    // file from OUTSIDE the sandbox (the .zcode/acp deny island keeps the
    // agent from editing its own allowlist). A symlinked/hardlinked config
    // or an unwritable path downgrades to a bridge-lifetime once-allow.
    if (wsRoot) {
      if (!appendSandboxAllow(wsRoot, targetReal)) server.sandboxOnceAllows.add(targetReal);
    } else {
      server.sandboxOnceAllows.add(targetReal);
      warn("sandbox: no workspace root known — allow persisted for this bridge lifetime only");
    }
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
