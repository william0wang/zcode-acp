/**
 * REPL orchestration (bare `zcode-acp`): spawn the bridge subprocess, connect
 * to it as an ACP client over stdio, create a session rooted at the current
 * directory, and pump session updates into the Ink UI.
 *
 * State lives here (plain variables + full rerender) — the App component is a
 * pure view over a snapshot. One process per conversation: closing the REPL
 * closes the bridge (its stdin-end shutdown path), which reaps the zcode
 * backend through the bridge's normal cleanup.
 */

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import process from "node:process";
import { fileURLToPath } from "node:url";

import * as acp from "@agentclientprotocol/sdk";
import type { ActiveSession } from "@agentclientprotocol/sdk";
import { render } from "ink";
import { createElement } from "react";
import { z } from "zod";

import { queryQuota } from "../quota/index.js";
import { AGENT_INFO, warn } from "../utils.js";
import {
  App,
  type AppProps,
  type PermissionPrompt,
  type QuestionAnswer,
  type QuestionPrompt,
  type SessionPick,
} from "./App.js";
import {
  applyStatusUpdate,
  applyUpdate,
  createReplStatus,
  createTurnState,
  finishTurn,
  formatQuotaLine,
  handleLocalCommand,
  parseCommand,
  parseQuestionForm,
  seedStatusFromNewSession,
  selectLabel,
  type QuestionForm,
  type ReplEntry,
  type SessionSummary,
  type TurnState,
} from "./model.js";
import { createLineEditor, type LineEditor } from "./input-buffer.js";

export async function runRepl(): Promise<void> {
  // Crash containment: an unexpected throw is SURFACED, never fatal — it
  // prints to stderr (stack included), lands as a dim note in the
  // transcript, and the REPL keeps running. A circuit breaker is the only
  // exit: if errors keep firing within the window the render tree itself is
  // almost certainly broken and every frame would throw again — shutting
  // down then beats a spinning error loop. Rejected promises are always
  // log-only; the SDK resolves raced/aborted request promises late by
  // design, and those settle as rejections we deliberately ignore.
  const CRASH_WINDOW_MS = 10_000;
  const CRASH_LIMIT = 5;
  let crashTimes: number[] = [];
  let repaintQueued = false;
  process.on("uncaughtException", (err) => {
    const now = Date.now();
    crashTimes = crashTimes.filter((t) => now - t < CRASH_WINDOW_MS);
    crashTimes.push(now);
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    warn(`repl absorbed an error (${crashTimes.length}/${CRASH_LIMIT} recent): ${detail}`);
    if (crashTimes.length >= CRASH_LIMIT) {
      warn("repl: too many errors in a row — UI is likely broken, shutting down");
      try {
        child.stdin?.end();
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        process.exit(1);
      }, 1500).unref();
      return;
    }
    const msg =
      (err instanceof Error ? err.message : String(err)).split("\n")[0] || "unknown error";
    entries = [...entries, { kind: "note", text: `error absorbed: ${msg}` }];
    // Repaint on a later tick: if the throw happened INSIDE a rerender,
    // re-entering ink synchronously from this handler would just rethrow.
    if (!repaintQueued && !exited) {
      repaintQueued = true;
      setTimeout(() => {
        repaintQueued = false;
        rerender();
      }, 50);
    }
  });
  process.on("unhandledRejection", (reason) => {
    warn(
      `repl ignored an async failure: ${
        reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
      }`,
    );
  });

  const serverJs = fileURLToPath(new URL("../index.js", import.meta.url));
  const child = spawn(process.execPath, [serverJs], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Bridge stderr (gated debug logs + warns) never interleaves with the Ink
  // UI; keep a tail so a bridge crash can be explained on exit.
  let stderrTail = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (d: string) => {
    stderrTail = (stderrTail + d).slice(-2000);
  });

  // --- UI state (external store; every mutation rerenders a fresh snapshot) ---
  let entries: ReplEntry[] = [];
  let turn: TurnState | null = null;
  let permission: PermissionPrompt | null = null;
  let question: QuestionPrompt | null = null;
  // Non-null while the /sessions picker is open (run-side holds the list; the
  // App owns the row index).
  let sessionPick: SessionPick | null = null;
  let status = createReplStatus();
  let busy = true;
  let exited = false;
  // True between a user submit and the stop message. The bridge also pushes
  // idle-time updates right after session/new (available_commands, mode
  // state, …) — without this gate those would spin up a phantom turn and
  // show the "running" spinner with nothing in flight.
  let turnActive = false;
  // True while a prompt WE sent is in flight (its stop message closes the
  // turn). Remote-initiated turns (mobile/second client) never deliver a stop
  // here — they are closed by `$/zcode/turnState running:false` instead.
  let promptInFlight = false;
  // True between a `/sessions` resume and the drained history backlog: during
  // this window streamed updates fold into static entries (see the pump).
  // `loadSettled` gates the DRAIN: the bridge streams replay notifications
  // while the load request is still in flight, so consuming early would let a
  // >10ms gap between two replayed messages falsely end replay mode.
  let replayMode = false;
  // The live ACP session. Starts as the fresh session/new placeholder; a
  // `/sessions` resume swaps it for an attached load of the picked backend
  // session (same pump, same update routing). Declared with the other
  // state, NOT at its bootstrap assignment below: /sessions can run while
  // that await is still in flight, and assigning a `let` before its
  // declaration executes is a TDZ ReferenceError.
  let activeSession: ActiveSession | null = null;
  let resumedDuringStartup = false;
  let loadSettled = true;
  let replayTurn: TurnState | null = null;
  const REPLAY_QUIET_MS = 10;
  // Resume loads only the last N messages (turn-aligned, ADR-0003 tail
  // replay). Full replay of a huge session would flood the native
  // scrollback with thousands of lines in one burst — a bounded recent tail
  // gives context without the wall-of-text scroll jump.
  const RESUME_TAIL_LIMIT = 50;
  const sleep = (ms: number): Promise<null> =>
    new Promise((resolve) => setTimeout(() => resolve(null), ms));
  // Prompts submitted while another turn runs (or before the session is
  // ready); drained one per stop, FIFO.
  const promptQueue: string[] = [];

  // Native-scrollback model: completed entries print once via ink <Static>
  // and become the terminal's own history (native smooth scroll, selection,
  // search — the Claude Code pattern). Only a compact dynamic footer below
  // (live-turn tail, queue panel, completion menu, input box) ever repaints.

  // --- prompt line editor (external store): the App re-renders from fresh
  // snapshots, so draft text must live out here to survive rerenders.
  let editor: LineEditor = createLineEditor();

  // --- completion-menu visibility mirror ---
  // InputLine publishes whether its menu is showing (plain var, no React
  // state); the app-level key handler reads it so an open menu takes the
  // first esc — dismissing it must not also interrupt a queued-up turn.
  let completionMenuOpen = false;

  // --- plan-quota indicator (prompt-line status suffix) ---
  // Fetched once at startup and refreshed every QUOTA_TTL_MS; null (hidden)
  // while the fetch runs or fails, so offline / auth-expired sessions just
  // lose the suffix instead of nagging. The full card stays available via
  // /quota. Failures are silent by design — warn() on every TTL tick would
  // spam long-lived sessions.
  let quotaLine: string | null = null;
  let quotaFetchId = 0;
  let quotaTimer: NodeJS.Timeout | null = null;
  const QUOTA_TTL_MS = 10 * 60 * 1000;
  async function refreshQuota(): Promise<void> {
    const id = ++quotaFetchId;
    try {
      const result = await queryQuota();
      if (exited || id !== quotaFetchId) return; // stale reply — a newer fetch owns the line
      const line = formatQuotaLine(result);
      if (line !== quotaLine) {
        quotaLine = line;
        rerender();
      }
    } catch {
      // best-effort indicator: leave whatever was last shown in place
    }
  }
  void refreshQuota();
  quotaTimer = setInterval(() => void refreshQuota(), QUOTA_TTL_MS);
  quotaTimer.unref();

  const renderOpts = { exitOnCtrlC: false };
  let ink = render(createElement(App, snapshot()), renderOpts);
  function snapshot(): AppProps {
    return {
      entries,
      turn,
      permission,
      question,
      sessionPick,
      queued: [...promptQueue],
      status,
      busy,
      replaying: replayMode,
      editor,
      applyEdit: (op) => {
        if (exited) return;
        editor = op(editor);
        rerender();
      },
      quotaLine,
      isMenuOpen: (): boolean => completionMenuOpen,
      onMenuOpenChange: (open: boolean) => {
        completionMenuOpen = open;
      },
      onSubmit: (text) => void onSubmit(text),
      onCancelTurn,
      onAnswerPermission: (id) => permissionResolver?.(id),
      onAnswerQuestion: (answer) => {
        const resolve = questionResolver;
        questionResolver = null;
        question = null;
        rerender();
        resolve?.(answer);
      },
      onPickSession: (sid) => sessionPickResolver?.(sid),
      onExit: () => cleanup(0),
    };
  }
  function rerender(): void {
    if (!exited) ink.rerender(createElement(App, snapshot()));
  }

  // --- Permission bridging: agent request → picker → response ---
  let permissionResolver: ((id: string | null) => void) | null = null;

  // --- AskUserQuestion bridging: elicitation form → picker → response ---
  let questionResolver: ((answer: QuestionAnswer | null) => void) | null = null;
  function askQuestion(form: QuestionForm, signal?: AbortSignal): Promise<QuestionAnswer | null> {
    return new Promise((resolve) => {
      const onAbort = () => {
        questionResolver = null;
        question = null;
        rerender();
        resolve(null);
      };
      const settle = (answer: QuestionAnswer | null): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve(answer);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      questionResolver = settle;
      question = {
        title: form.title,
        multiSelect: form.multiSelect,
        options: form.options,
      };
      rerender();
    });
  }

  // --- /sessions bridging: list → picker → resume ---
  let sessionPickResolver: ((sessionId: string | null) => void) | null = null;

  // --- ACP client connection ---
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin! as Writable),
    Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
  );
  const app = acp
    .client({ name: "zcode-acp" })
    .onRequest("session/request_permission", async (ctx) => {
      // A remote client (mobile/hub) may answer the broadcast request first;
      // the bridge then cancels this losing copy and the SDK aborts
      // ctx.signal — settle here so our picker dismisses instead of hanging.
      const id = await new Promise<string | null>((resolve) => {
        const onAbort = () => {
          permissionResolver = null;
          permission = null;
          rerender();
          resolve(null);
        };
        ctx.signal.addEventListener("abort", onAbort, { once: true });
        permissionResolver = (v) => {
          ctx.signal.removeEventListener("abort", onAbort);
          resolve(v);
        };
        const options = ctx.params.options.map((o) => ({ id: o.optionId, name: o.name }));
        // ExitPlanMode arrives as an approve/reject permission pair (see
        // interaction/adapter.ts); head it as a plan approval and show the
        // plan text so the decision is actually reviewable.
        const isPlan =
          options.length === 2 && options.every((o) => o.id === "approve" || o.id === "reject");
        const raw = ctx.params.toolCall?.rawInput;
        permission = {
          heading: isPlan ? "plan approval" : "permission requested",
          title: ctx.params.toolCall?.title ?? "tool call",
          detail: typeof raw === "string" ? raw : undefined,
          options,
        };
        rerender();
      });
      permissionResolver = null;
      permission = null;
      rerender();
      return id === null
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { outcome: "selected", optionId: id } };
    })
    .onRequest("elicitation/create", async (ctx) => {
      // AskUserQuestion arrives as the bridge's form elicitation. Each
      // question walks the picker sequentially; skipped questions omit
      // their key (the backend treats them as unanswered).
      const forms = parseQuestionForm(ctx.params);
      if (!forms) return { action: "decline", reason: "unsupported elicitation form" };
      const content: Record<string, string | string[]> = {};
      for (const form of forms) {
        const answer = await askQuestion(form, ctx.signal);
        // A remote client winning the broadcast aborts our request via
        // ctx.signal — stop answering instead of walking remaining questions.
        if (ctx.signal.aborted) return { action: "decline", reason: "cancelled" };
        if (answer === null) continue; // skipped
        if (form.multiSelect) {
          const merged = [...answer.picked, ...(answer.custom ? [answer.custom] : [])];
          if (merged.length > 0) content[form.key] = merged;
        } else {
          content[form.key] = answer.custom || answer.picked[0] || "";
        }
      }
      return { action: "accept", content };
    })
    // Out-of-band turn indicator broadcast by the bridge on every prompt start
    // and end. Drives turns the REPL did NOT start itself: a mobile/second
    // client prompting this session must render here too — without it those
    // updates would be silently dropped (the pump only folds updates while a
    // turn is active).
    .onNotification(
      "$/zcode/turnState",
      z.object({ sessionId: z.string(), running: z.boolean() }),
      (ctx) => {
        if (!activeSession || ctx.params.sessionId !== activeSession.sessionId) return;
        if (ctx.params.running) {
          // Local prompts already opened the turn in startTurn; idempotent.
          if (!turnActive && !replayMode) {
            turn = createTurnState();
            turnActive = true;
            rerender();
          }
        } else if (turnActive && !promptInFlight) {
          // Remote turn finished (no stop message reaches non-initiators).
          entries = [...entries, ...finishTurn(turn ?? createTurnState())];
          turn = null;
          turnActive = false;
          drainQueue();
          rerender();
        }
      },
    )
    .connect(stream);
  const cx = app.agent;

  // Advertise form-elicitation so AskUserQuestion routes here as a
  // structured form instead of permission-popups labeled "permission
  // requested". The SDK never sends a protocol-level initialize on the
  // client's behalf, so this request() IS the handshake (the bridge rejects
  // any earlier non-initialize message). Sent via the generic request() —
  // the typed helper lives on the Agent interface, not the ClientContext we
  // hold.
  await cx.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      elicitation: { form: {} },
    },
    clientInfo: { name: "zcode-acp", title: "zcode-acp REPL", version: AGENT_INFO.version },
  });

  try {
    const fresh = await cx.buildSession(process.cwd()).start();
    if (resumedDuringStartup) {
      // The user picked a session from /sessions while this cold-start
      // round-trip was still in flight — the fresh placeholder is already
      // obsolete and its default status must not overwrite the resumed
      // session's own seeded selects. Discard it, keep what they expect.
      fresh.dispose();
    } else {
      activeSession = fresh;
      // The initial config options ride the session/new response body, not a
      // notification — seed the status from it; later switches push updates.
      status = seedStatusFromNewSession(status, activeSession.newSessionResponse);
    }
  } catch (err) {
    entries = [
      ...entries,
      {
        kind: "note",
        text: `failed to start session: ${err instanceof Error ? err.message : String(err)}`,
      },
    ];
    rerender();
    cleanup(1);
    return;
  }
  busy = false;
  drainQueue();

  // --- Update pump: fold notifications into the live turn, stop closes it ---
  void (async () => {
    for (;;) {
      let msg;
      try {
        if (replayMode) {
          // Wait for the load response before draining: only then is the
          // whole replay backlog guaranteed to be queued, making the quiet
          // timeout a reliable end-of-replay signal.
          if (!loadSettled) {
            await sleep(REPLAY_QUIET_MS);
            continue;
          }
          msg = await Promise.race([activeSession!.nextUpdate(), sleep(REPLAY_QUIET_MS)]);
          if (msg === null) {
            // Backlog drained — flush the folded history as static entries.
            replayMode = false;
            if (replayTurn) {
              entries = [...entries, ...finishTurn(replayTurn)];
              replayTurn = null;
            }
            rerender();
            continue;
          }
        } else {
          msg = await activeSession!.nextUpdate();
        }
      } catch {
        // A `/sessions` resume disposes the previous ActiveSession, which
        // fails this pending read — re-arm on the (possibly new) session
        // instead of killing the pump and orphaning every later update.
        await sleep(REPLAY_QUIET_MS * 2);
        continue;
      }
      if (msg.kind === "stop") {
        promptInFlight = false;
        entries = [...entries, ...finishTurn(turn ?? createTurnState(), msg.response.stopReason)];
        turn = null;
        turnActive = false;
        drainQueue();
      } else {
        // Status pushes (command menu, config selects) fold regardless of turn
        // activity — the update that follows a `/model X` switch arrives while
        // that slash turn is still open. Turn payloads and replayed history
        // fold into their respective buffers.
        const nextStatus = applyStatusUpdate(status, msg.update);
        const statusChanged = nextStatus !== status;
        status = nextStatus;
        if (replayMode && replayTurn) {
          // Fold silently: replayed history isn't rendered per message
          // (thousands of full-frame renders froze input on big sessions).
          // App shows one static "restoring history…" row instead; the drain
          // below paints the whole transcript once.
          replayTurn = applyUpdate(replayTurn, msg.update);
        } else if (turnActive) {
          turn = applyUpdate(turn ?? createTurnState(), msg.update);
          rerender();
        } else if (statusChanged) {
          rerender();
        }
      }
    }
  })();

  async function onSubmit(text: string): Promise<void> {
    const cmd = parseCommand(text);
    if (cmd === "exit") {
      cleanup(0);
      return;
    }
    if (cmd === "sessions") {
      entries = [...entries, { kind: "user", text }];
      void openSessionPicker();
      return;
    }
    entries = [...entries, { kind: "user", text }];
    // REPL-local commands (help / arg-less listing forms) render here and
    // never reach the bridge; everything else is a prompt (slash interception
    // lives bridge-side, same path editors use).
    const local = handleLocalCommand(text, status);
    if (local) {
      entries = [...entries, ...local];
      rerender();
      return;
    }
    if (!activeSession || turnActive) {
      // Follow-ups while a turn is running (or the session is still starting)
      // are queued; the stop handler drains them one at a time. Resetting the
      // live turn here would discard its entries mid-stream.
      promptQueue.push(text);
      rerender();
      return;
    }
    await startTurn(text);
  }

  async function startTurn(text: string): Promise<void> {
    turn = createTurnState();
    turnActive = true;
    promptInFlight = true;
    rerender();
    try {
      await activeSession!.prompt(text);
    } catch (err) {
      // The pump's stop message still flushes the turn; surface the error too.
      // The queue is NOT drained here: racing a queued prompt against the
      // pending stop would close that next turn prematurely.
      entries = [
        ...entries,
        {
          kind: "note",
          text: `prompt failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ];
      turn = null;
      turnActive = false;
      promptInFlight = false;
      rerender();
    }
  }

  /** Start the next queued prompt after a turn ends; go idle when empty. */
  function drainQueue(): void {
    const next = promptQueue.shift();
    if (next === undefined) {
      turnActive = false;
      rerender();
      return;
    }
    // Route through onSubmit, not startTurn directly: queued entries still
    // go through command parsing (a queued "/help" must render locally,
    // "/exit" must exit — never reach the bridge as a literal prompt).
    void onSubmit(next);
  }

  function onCancelTurn(): void {
    if (!activeSession || !turn) return;
    try {
      void cx.notify("session/cancel", { sessionId: activeSession.sessionId });
    } catch {
      // best-effort; a second ctrl-c exits outright
    }
  }

  /**
   * `/sessions`: list this project's sessions via ACP `session/list` (the
   * backend filters by workspace), let the user pick one interactively, then
   * resume it with `session/load` (full history replayed into the transcript).
   */
  async function openSessionPicker(): Promise<void> {
    if (turnActive) {
      entries = [
        ...entries,
        { kind: "note", text: "a turn is running — try /sessions when it finishes" },
      ];
      rerender();
      return;
    }
    let list: {
      sessions?: Array<{
        sessionId: string;
        cwd?: string;
        title?: string | null;
        updatedAt?: string | null;
      }>;
    };
    try {
      list = (await cx.request("session/list", { cwd: process.cwd() })) as typeof list;
    } catch (err) {
      entries = [
        ...entries,
        {
          kind: "note",
          text: `failed to list sessions: ${err instanceof Error ? err.message : String(err)}`,
        },
      ];
      rerender();
      return;
    }
    const items: SessionSummary[] = (list.sessions ?? []).map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd ?? "",
      title: s.title ?? null,
      updatedAt: s.updatedAt ?? null,
    }));
    if (items.length === 0) {
      entries = [...entries, { kind: "note", text: "no previous sessions in this project yet" }];
      rerender();
      return;
    }
    const sid = await new Promise<string | null>((resolve) => {
      sessionPickResolver = resolve;
      sessionPick = { items };
      rerender();
    });
    sessionPick = null;
    sessionPickResolver = null;
    rerender();
    const picked = items.find((s) => s.sessionId === sid);
    if (sid && picked) {
      resumedDuringStartup = true;
      await resumeInto(picked);
    }
  }

  /**
   * Swap the live session for a loaded one. The bridge streams the whole
   * conversation back as `session/update` notifications before resolving the
   * `session/load` request, so an ActiveSession must be attached BEFORE the
   * request goes out or every replayed message is dropped by the SDK's
   * update router. `attachSession` is @internal in the typings but stable at
   * runtime — the only client-side path from a raw sessionId to update
   * routing (`buildSession().start()` only covers session/new).
   */
  async function resumeInto(picked: SessionSummary): Promise<void> {
    const loaded = (
      cx as unknown as {
        attachSession(response: { sessionId: string }): ActiveSession;
      }
    ).attachSession({ sessionId: picked.sessionId });
    activeSession?.dispose();
    activeSession = loaded;
    replayTurn = createTurnState();
    replayMode = true;
    loadSettled = false;
    // Paint the restoring-history hint BEFORE the (long) load round-trip.
    rerender();
    let resumeMeta: {
      replayedMessages?: number;
      totalMessages?: number;
      hasMore?: boolean;
    } | null = null;
    try {
      const resp = (await cx.request("session/load", {
        sessionId: picked.sessionId,
        cwd: process.cwd(),
        mcpServers: [],
        // Tail replay (ADR-0003): bounded recent history instead of the full
        // transcript — the REPL scrollback doesn't need 10k lines at once.
        _meta: { zcode: { limit: RESUME_TAIL_LIMIT } },
      })) as {
        configOptions?: acp.SessionConfigOption[] | null;
        replayMeta?: { replayedMessages?: number; totalMessages?: number; hasMore?: boolean };
      };
      status = seedStatusFromNewSession(status, resp);
      resumeMeta = resp.replayMeta ?? null;
    } catch (err) {
      replayMode = false;
      replayTurn = null;
      entries = [
        ...entries,
        {
          kind: "note",
          text: `resume failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ];
      rerender();
      return;
    } finally {
      loadSettled = true;
    }
    const title = picked.title?.trim() || picked.sessionId.slice(0, 8);
    const m = resumeMeta;
    const truncated =
      m?.hasMore && typeof m.replayedMessages === "number" && typeof m.totalMessages === "number"
        ? ` — showing last ${m.replayedMessages} of ${m.totalMessages} messages`
        : "";
    entries = [
      ...entries,
      { kind: "note", text: `resumed "${title}"${truncated || " — history restored above"}` },
    ];
    rerender();
  }

  // Terminal resize: the dynamic footer re-wraps at the new width via a
  // plain rerender. Already-printed scrollback keeps its old wrapping —
  // that's exactly how native-history CLIs (Claude Code et al.) behave.
  const onResize = (): void => {
    if (exited) return;
    rerender();
  };
  if (process.stdout.isTTY) process.stdout.on("resize", onResize);

  function cleanup(code: number): void {
    if (exited) return;
    exited = true;
    try {
      if (quotaTimer !== null) clearInterval(quotaTimer);
      quotaTimer = null;
    } catch {
      // ignore
    }
    try {
      process.stdout.off("resize", onResize);
    } catch {
      // ignore
    }
    // Each step is guarded: one throwing (e.g. unmount during a render) must
    // not skip the child shutdown and leave the process hanging.
    try {
      activeSession?.dispose();
    } catch {
      // ignore
    }
    try {
      ink.unmount();
    } catch {
      // ignore
    }
    try {
      // Graceful path: closing stdin triggers the bridge's own shutdown,
      // which reaps the zcode backend group.
      child.stdin?.end();
    } catch {
      // ignore
    }
    setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    // Hard fallback: if the bridge ignores stdin-close shutdown (or the exit
    // event is lost), the REPL still exits instead of hanging forever.
    setTimeout(() => process.exit(code), 5000);
    child.once("exit", () => {
      if (code !== 0 && stderrTail.trim()) {
        process.stderr.write(`\nbridge stderr tail:\n${stderrTail}\n`);
      }
      process.exit(code);
    });
  }

  // Bridge died under us (crash, backend failure) — report and exit hard.
  child.once("exit", (code) => {
    if (exited) return;
    exited = true;
    ink.unmount();
    process.stderr.write(
      `bridge exited unexpectedly (code ${code})\n${stderrTail.trim() ? `stderr tail:\n${stderrTail}` : ""}\n`,
    );
    process.exit(1);
  });

  // Welcome panel as the first transcript entry — branding, session info,
  // seeded config, and key hints; pushed into scrollback by the first prompt.
  entries = [
    {
      kind: "welcome",
      info: {
        version: AGENT_INFO.version,
        cwd: process.cwd(),
        model: selectLabel(status.model),
        mode: selectLabel(status.mode),
        thought: selectLabel(status.thought),
      },
    },
  ];
  rerender();
}
