#!/usr/bin/env node
/**
 * E2E check: drive the zcode-acp bridge over stdio with a minimal ACP client,
 * set /goal, and log every session/update the client receives.
 *
 * Success criteria (issue #178 fix): goal-loop round events (tool calls and
 * agent message chunks) arrive at the client with proper types — not silence.
 */
import { spawn } from "node:child_process";
import { setTimeout } from "node:timers";
import { mkdirSync } from "node:fs";

const DIST = process.argv[2] ?? new URL("../dist/index.js", import.meta.url).pathname;
const CWD = "/tmp/goal-e2e";
mkdirSync(CWD, { recursive: true });

const proc = spawn(process.execPath, [DIST], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const pending = new Map();
let nextId = 1;
const updates = [];
const textChunks = [];

proc.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method === "session/update") {
      const u = msg.params?.update ?? {};
      const kind = u.sessionUpdate ?? u.kind ?? "?";
      updates.push(kind);
      if (kind === "agent_message_chunk") textChunks.push(u.content?.text ?? "");
      const brief =
        kind === "tool_call"
          ? `tool_call: ${u.title ?? u.tool ?? "?"} [${u.status ?? "?"}]`
          : kind === "agent_message_chunk"
            ? `text: ${(u.content?.text ?? "").slice(0, 80).replace(/\n/g, " ")}`
            : kind;
      console.log(`  <- ${brief}`);
    }
  }
});

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }
    }, 180_000);
  });
}

const toolCalls = () => updates.filter((k) => k === "tool_call").length;
const chunks = () => textChunks.join("");

try {
  console.log(`bridge: ${DIST}`);
  const init = await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  console.log(`initialized, protocol=${init.protocolVersion}`);
  const { sessionId } = await send("session/new", { cwd: CWD, mcpServers: [] });
  console.log(`session: ${sessionId}`);

  console.log("-- sending /goal prompt");
  const resp = await send("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "/goal Reply with exactly DONE and nothing else" }],
  });
  console.log(`-- prompt finished: stopReason=${resp.stopReason} (rounds keep running)`);

  // The prompt returns right after "goal set"; the loop's rounds continue in
  // the background. Wait for round activity: any event after the initial
  // goal-loop banner/set texts.
  const baseline = updates.length;
  const deadline = Date.now() + 300_000;
  console.log("-- waiting for goal round activity (max 5min)...");
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    if (updates.length > baseline) break;
  }

  console.log(`\n== RESULT: ${updates.length} session/update events, ${toolCalls()} tool_call(s)`);
  console.log(`== text received: ${chunks().slice(0, 400).replace(/\n/g, " | ")}`);
  // PASS = at least one round event streamed AFTER the goal-set acknowledgement
  const streamed = updates.length > baseline;
  console.log(
    streamed
      ? "== PASS: goal round streamed to client"
      : "== FAIL: no round events reached the client (issue #178 symptom)",
  );
  process.exit(streamed ? 0 : 1);
} catch (e) {
  console.error("E2E error:", e.message);
  process.exit(2);
} finally {
  proc.kill("SIGKILL");
}
