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
import { log, warn } from "../utils.js";
import type { PendingTurn, ZcodeAcpServer } from "../server.js";
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
 * approval, arm the restart (kill backend, flag the turn cancelled, queue
 * the continuation prompt). Best-effort: any failure keeps the sandbox
 * exactly as it was.
 */
export async function handleSandboxDenial(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  turn: PendingTurn,
  denial: SandboxDenial,
  toolCallId: string,
): Promise<void> {
  // Process-level fact, not the config wish: the caller gates on the same
  // flag, so a sandbox armed only via project config (no env) still flows.
  if (!server.backendSandboxed) return;
  // The shell printed the path relative to the SESSION cwd — resolve against
  // that, not the bridge's own cwd (they differ for remote/hub clients).
  const raw = denial.isMkdir ? denial.path : path.dirname(denial.path);
  const cwd = server.sessionCwds.get(acpSid);
  const wsRoot = cwd;
  const targetReal = resolveReal(
    path.isAbsolute(raw) ? raw : path.resolve(cwd ?? process.cwd(), raw),
  );

  // Debounce: one ask per path per session — the model retries the same
  // denied path and must not spam the popup; rejected/timeout asks count.
  let asked = server.sandboxAskedPaths.get(acpSid);
  if (!asked) {
    asked = new Set();
    server.sandboxAskedPaths.set(acpSid, asked);
  }
  if (asked.has(targetReal)) return;
  asked.add(targetReal);

  // Island / strictGit denials are unallowable by construction (their denies
  // win the last-match). Tell the USER why instead of a doomed popup — the
  // model only ever sees the bare EPERM in its tool output.
  if (underAny(targetReal, protectedSandboxPaths(server.sandboxRoots()))) {
    await sendTextChunk(
      cx,
      acpSid,
      "[该路径受沙箱保护(.zcode/acp 配置区或 strictGit 的 .git),不能通过弹窗放行。strictGit 可在 .zcode/acp/sandbox.json 中关闭。]",
      randomUUID(),
    );
    return;
  }

  // Phantom-ask guard: echoed EPERM text can also extract a path no syscall
  // ever tried to write — and a grant for $HOME (or any of its ancestors)
  // would effectively gut the sandbox. Such asks are refused; hand-editing
  // the config is the only way to grant something this broad.
  const home = resolveReal(os.homedir());
  if (targetReal === "/" || targetReal === home || home.startsWith(targetReal + path.sep)) {
    await sendTextChunk(
      cx,
      acpSid,
      `[${targetReal} 范围过宽($HOME 或其上级),沙箱不会弹窗放行;确需放行请手动编辑 .zcode/acp/sandbox.json 的 allow 列表。]`,
      randomUUID(),
    );
    return;
  }

  // A persisted "永不放行" decision — VISIBLE config, never hidden bridge
  // memory: no popup, and the asked-mark above keeps later repeats silent.
  if (wsRoot && underAny(targetReal, readSandboxConfig(wsRoot).deny.map(resolveReal))) {
    await sendTextChunk(
      cx,
      acpSid,
      `[${targetReal} 已在 .zcode/acp/sandbox.json 的 deny 列表中(你之前选择过始终拒绝)。要撤销,编辑该文件的 deny 数组即可。]`,
      randomUUID(),
    );
    return;
  }

  const options = [
    { optionId: "sandbox_allow_always", kind: "allow_always" as const, name: "始终允许" },
    { optionId: "sandbox_allow_once", kind: "allow_once" as const, name: "仅此一次" },
    { optionId: "sandbox_reject_once", kind: "reject_once" as const, name: "拒绝一次" },
    { optionId: "sandbox_reject_always", kind: "reject_always" as const, name: "始终拒绝" },
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
          title: `沙箱写入放行:${targetReal}`,
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: `沙箱拒绝了工作区外的写入:${targetReal}\n“始终允许”写入配置的 allow 列表,“始终拒绝”写入 deny 列表(.zcode/acp/sandbox.json,可编辑撤销)。`,
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
    // Popup failed/timed out or the client rejected the request itself —
    // keep the sandbox unchanged; the asked-mark prevents a retry loop.
    warn(
      `sandbox: allow ask for ${targetReal} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }

  if (decision === "reject_always") {
    // The user's denial is persisted VISIBLY into the project config — never
    // silently remembered in bridge memory. If the config can't be written,
    // nothing is stored: the ask simply resurfaces next time.
    const persisted = wsRoot ? appendSandboxDeny(wsRoot, targetReal) : false;
    await sendTextChunk(
      cx,
      acpSid,
      persisted
        ? `[已记入始终拒绝 ${targetReal}(.zcode/acp/sandbox.json 的 deny 列表,可编辑撤销)。]`
        : `[已拒绝 ${targetReal}(配置不可写,未持久化,同类写入下次仍会询问。)]`,
      randomUUID(),
    );
    return;
  }

  if (decision === "reject_once" || decision === "deny") {
    await sendTextChunk(
      cx,
      acpSid,
      `[已拒绝沙箱放行 ${targetReal},未保存任何决定,同类写入会再次询问;如需放行,可编辑 .zcode/acp/sandbox.json 的 allow 列表(由桥写入,Agent 不可改)。]`,
      randomUUID(),
    );
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

  // Arm the restart: flag the turn so the loop unwinds as cancelled instead
  // of polling a dead reader, queue the continuation prompt, kill the
  // backend process group (next ensureBackend() respawns with the widened
  // profile — once-allows and the persisted config are both folded in).
  // Other sessions' in-flight turns are cancelled too — they share this
  // backend and would otherwise hang on the dead reader.
  turn.cancelled = true;
  turn.stopSent = true; // no stop pair needed: the whole process group dies
  server.cancelAllPendingTurns();
  server.sandboxContinuations.set(acpSid, `[沙箱已放行 ${targetReal},请继续刚才的任务。]`);
  await sendTextChunk(
    cx,
    acpSid,
    `[沙箱已放行 ${targetReal},正在重启后端以应用新权限,随后自动继续…]`,
    randomUUID(),
  );
  log(`sandbox: allow granted for ${targetReal} (${decision}) — restarting backend`);
  try {
    await server.ensureBackend().close();
  } catch (e) {
    warn(`sandbox: backend kill failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
