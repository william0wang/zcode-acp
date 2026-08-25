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

import { AGENT_INFO } from "../utils.js";
import { App, type AppProps, type PermissionPrompt } from "./App.js";
import {
  applyUpdate,
  createTurnState,
  finishTurn,
  parseCommand,
  type ReplEntry,
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
  let busy = true;
  let exited = false;
  // True between a user submit and the stop message. The bridge also pushes
  // idle-time updates right after session/new (available_commands, mode
  // state, …) — without this gate those would spin up a phantom turn and
  // show the "running" spinner with nothing in flight.
  let turnActive = false;
  // Prompts submitted while another turn runs (or before the session is
  // ready); drained one per stop, FIFO.
  const promptQueue: string[] = [];

  const ink = render(createElement(App, snapshot()), { exitOnCtrlC: false });
  function snapshot(): AppProps {
    return {
      entries,
      turn,
      permission,
      busy,
      onSubmit: (text) => void onSubmit(text),
      onCancelTurn,
      onAnswerPermission: (id) => permissionResolver?.(id),
      onExit: () => cleanup(0),
    };
  }
  function rerender(): void {
    if (!exited) ink.rerender(createElement(App, snapshot()));
  }

  // --- Permission bridging: agent request → picker → response ---
  let permissionResolver: ((id: string | null) => void) | null = null;

  // --- ACP client connection ---
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin! as Writable),
    Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
  );
  const app = acp
    .client({ name: "zcode-acp" })
    .onRequest("session/request_permission", async (ctx) => {
      const id = await new Promise<string | null>((resolve) => {
        permissionResolver = resolve;
        permission = {
          title: ctx.params.toolCall?.title ?? "tool call",
          options: ctx.params.options.map((o) => ({ id: o.optionId, name: o.name })),
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
    .connect(stream);
  const cx = app.agent;

  let session: ActiveSession | null = null;
  try {
    session = await cx.buildSession(process.cwd()).start();
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
        msg = await session!.nextUpdate();
      } catch {
        return; // session disposed on exit
      }
      if (msg.kind === "stop") {
        entries = [...entries, ...finishTurn(turn ?? createTurnState(), msg.response.stopReason)];
        turn = null;
        drainQueue();
      } else if (turnActive) {
        turn = applyUpdate(turn ?? createTurnState(), msg.update);
        rerender();
      }
      // Idle-time updates outside a user turn are dropped (v1 has no command
      // palette or mode display to feed them into).
    }
  })();

  async function onSubmit(text: string): Promise<void> {
    if (parseCommand(text) === "exit") {
      cleanup(0);
      return;
    }
    entries = [...entries, { kind: "user", text }];
    if (!session || turnActive) {
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
    rerender();
    try {
      await session!.prompt(text);
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
    if (!session || !turn) return;
    try {
      void cx.notify("session/cancel", { sessionId: session.sessionId });
    } catch {
      // best-effort; a second ctrl-c exits outright
    }
  }

  function cleanup(code: number): void {
    if (exited) return;
    exited = true;
    // Each step is guarded: one throwing (e.g. unmount during a render) must
    // not skip the child shutdown and leave the process hanging.
    try {
      session?.dispose();
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

  // Welcome banner as the first transcript entry.
  entries = [
    {
      kind: "note",
      text: `${AGENT_INFO.name} v${AGENT_INFO.version} — session ready (${process.cwd()}). /exit to quit · ctrl-c cancels a running turn · idle ctrl-c twice quits`,
    },
  ];
  rerender();
}
