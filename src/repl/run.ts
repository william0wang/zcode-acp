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

import { AGENT_INFO } from "../utils.js";
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

export async function runRepl(): Promise<void> {
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
  // Bumped on every terminal resize so the App remounts <Static> and repaints
  // the whole transcript at the new width.
  let resizeTick = 0;
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
  let loadSettled = true;
  let replayTurn: TurnState | null = null;
  const REPLAY_QUIET_MS = 10;
  const sleep = (ms: number): Promise<null> =>
    new Promise((resolve) => setTimeout(() => resolve(null), ms));
  // Prompts submitted while another turn runs (or before the session is
  // ready); drained one per stop, FIFO.
  const promptQueue: string[] = [];

  // Full-screen app: ink takes over the whole terminal (alternate screen
  // buffer). The transcript lives in an in-app viewport — nothing prints to
  // the terminal's own scrollback, which is what makes resizes clean.
  const ink = render(createElement(App, snapshot()), {
    exitOnCtrlC: false,
    alternateScreen: true,
  });
  function snapshot(): AppProps {
    return {
      entries,
      turn,
      permission,
      question,
      sessionPick,
      resizeTick,
      status,
      busy,
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
  // requested". The connection's auto-initialize carries no capabilities, so
  // a follow-up initialize re-merges them (the bridge's handler is
  // idempotent). Sent via the generic request() — the typed helper lives on
  // the Agent interface, not the ClientContext we hold.
  await cx.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      elicitation: { form: {} },
    },
    clientInfo: { name: "zcode-acp", title: "zcode-acp REPL", version: AGENT_INFO.version },
  });

  // The live ACP session. Starts as the fresh session/new placeholder; a
  // `/sessions` resume swaps it for an attached load of the picked backend
  // session (same pump, same update routing).
  let activeSession: ActiveSession | null = null;
  try {
    activeSession = await cx.buildSession(process.cwd()).start();
    // The initial config options ride the session/new response body, not a
    // notification — seed the status from it; later switches push updates.
    status = seedStatusFromNewSession(status, activeSession.newSessionResponse);
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
          replayTurn = applyUpdate(replayTurn, msg.update);
          rerender();
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
    void startTurn(next);
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
    if (sid && picked) await resumeInto(picked);
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
    try {
      const resp = (await cx.request("session/load", {
        sessionId: picked.sessionId,
        cwd: process.cwd(),
        mcpServers: [],
      })) as { configOptions?: acp.SessionConfigOption[] | null };
      status = seedStatusFromNewSession(status, resp);
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
    entries = [...entries, { kind: "note", text: `resumed "${title}" — history restored above` }];
    rerender();
  }

  // Terminal resize: scrollback printed at the old width soft-wraps under the
  // new width and shifts every line, which is what makes resizes look
  // scrambled (ink only clears its own dynamic region). Clear the screen and
  // bump resizeTick so <Static> remounts and repaints EVERYTHING at the new
  // width — the full-screen-TUI answer.
  const onResize = (): void => {
    if (exited) return;
    try {
      process.stdout.write("\x1b[2J\x1b[1;1H");
    } catch {
      // best-effort; the repaint below still re-renders the dynamic area
    }
    resizeTick++;
    rerender();
  };
  if (process.stdout.isTTY) process.stdout.on("resize", onResize);

  function cleanup(code: number): void {
    if (exited) return;
    exited = true;
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
