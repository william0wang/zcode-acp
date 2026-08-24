/**
 * One-shot session title tests: the title is set exactly ONCE, from the FIRST
 * prompt of a freshly created session, before the turn even runs. No later
 * automatic path may change it — not the completing turn's end_turn, not a
 * preempting prompt. A manual rename is the only later modifier.
 *
 * Bug history (2026-08-24): the title used to be set on the first end_turn
 * from that turn's prompt text. A message interrupting the first turn
 * preempted it (stopReason "cancelled" — never titled), so the interruptor's
 * end_turn titled the session after the interrupting message.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeEvent } from "../src/backend/types.js";
import { prompt } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

// Record title persists so tests can assert the tasks-index write (the real
// module writes the App's ~/.zcode/v2/tasks-index.sqlite — never in tests).
const titlePersists: Array<{ taskId: string; title: string; text: string }> = [];
vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async () => true,
  updateSessionTitle: async (taskId: string, title: string, text: string) => {
    titlePersists.push({ taskId, title, text });
    return true;
  },
}));

beforeEach(() => {
  titlePersists.length = 0;
});

/** cx recording every session_info_update title pushed to the editor. */
function collectCx(): { cx: acp.AgentContext; titles: string[] } {
  const titles: string[] = [];
  const cx = {
    notify: async (_method: string, params: Record<string, unknown>) => {
      const update = params?.update as Record<string, unknown> | undefined;
      if (update?.sessionUpdate === "session_info_update") {
        titles.push(update.title as string);
      }
    },
    request: async () => ({}),
  } as unknown as acp.AgentContext;
  return { cx, titles };
}

/** Fake backend whose session/send delivers `events()` to all listeners. */
function scriptedBackend(events: () => ZcodeEvent[]): ZcodeBackend {
  const listeners: Array<{ handleEvent: (e: ZcodeEvent) => void }> = [];
  return {
    isDead: false,
    request: async (_id: number, method: string) => {
      switch (method) {
        case "workspace/updateProviderRegistry":
        case "session/resume":
        case "session/subscribe":
          return { result: {} };
        case "session/read":
          return { result: { projection: { status: "idle", contextUsed: 0 }, settings: {} } };
        case "session/messages":
          return { result: { messages: [] } };
        case "session/send": {
          for (const e of events()) {
            for (const l of listeners) l.handleEvent(e);
          }
          return { result: { accepted: true } };
        }
        default:
          return { error: { message: `unhandled ${method}` } };
      }
    },
    send: () => {},
    pollServerRequests: () => [],
    registerEventListener: (_sid: string, l: { handleEvent: (e: ZcodeEvent) => void }) => {
      listeners.push(l);
    },
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
}

/** Server with a pre-registered, backend-loaded session. */
function setup(backend: ZcodeBackend): ZcodeAcpServer {
  const server = new ZcodeAcpServer();
  server.backend = backend;
  server.registerSession("sess_ts", "zs_ts");
  server.markBackendLoaded("sess_ts");
  return server;
}

function promptParams(text: string): acp.PromptRequest {
  return { sessionId: "sess_ts", prompt: [{ type: "text", text }] } as acp.PromptRequest;
}

describe("one-shot session title (set once at the FIRST prompt)", () => {
  it("sets the title from the first prompt before the turn runs, once", async () => {
    const server = setup(
      scriptedBackend(() => [
        { type: "turn.started" },
        { type: "turn.completed", payload: { resultType: "success" } },
      ]),
    );
    server.titleEligibleSessions.add("sess_ts");
    const { cx, titles } = collectCx();

    // Drain microtasks up to (but not including) session/send: the title must
    // already be settled by the time the turn starts.
    const p = prompt(server, promptParams("first message question"), cx, 1);
    await vi.waitFor(() => expect(server.sessionTitles.get("sess_ts")).toBeTruthy());
    expect(server.sessionSummaries.get("sess_ts")?.title).toBe("first message question");
    expect(titles).toEqual(["first message question"]);
    expect(titlePersists).toEqual([
      { taskId: "zs_ts", title: "first message question", text: "first message question" },
    ]);

    const result = await p;
    expect(result).toEqual({ stopReason: "end_turn" });
    // end_turn did NOT re-set anything: still exactly one notify + one persist.
    expect(titles).toEqual(["first message question"]);
    expect(titlePersists).toHaveLength(1);
  });

  it("a preempting second message cannot steal or change the title", async () => {
    let sendCount = 0;
    const server = setup(
      scriptedBackend(() => {
        sendCount++;
        if (sendCount === 1) {
          // First turn parks after turn.started — it never completes on its
          // own; only the preemptor's fan-out events carry a terminal event.
          return [{ type: "turn.started" }];
        }
        return [
          { type: "turn.started" },
          {
            type: "model.streaming",
            payload: { kind: "text_delta", delta: "answer", assistantMessageId: "m2" },
          },
          { type: "turn.completed", payload: { resultType: "success" } },
        ];
      }),
    );
    server.titleEligibleSessions.add("sess_ts");
    const { cx, titles } = collectCx();

    const p1 = prompt(server, promptParams("first message question\nsecond line"), cx, 101);
    await vi.waitFor(() => expect(sendCount).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Title settled from the FIRST prompt's first line while its turn is
    // still in flight.
    expect(server.sessionTitles.get("sess_ts")).toBe("first message question");

    const p2 = prompt(server, promptParams("interrupting message"), cx, 102);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toEqual({ stopReason: "cancelled" });
    expect(r2).toEqual({ stopReason: "end_turn" });
    // The interruptor neither stole nor re-set the title.
    expect(server.sessionTitles.get("sess_ts")).toBe("first message question");
    expect(server.sessionSummaries.get("sess_ts")?.title).toBe("first message question");
    expect(titles).toEqual(["first message question"]);
    expect(titlePersists).toHaveLength(1);
  });

  it("a later prompt in an already-titled session changes nothing", async () => {
    const server = setup(
      scriptedBackend(() => [
        { type: "turn.started" },
        { type: "turn.completed", payload: { resultType: "success" } },
      ]),
    );
    server.titleEligibleSessions.add("sess_ts");
    const { cx, titles } = collectCx();

    await prompt(server, promptParams("original title source"), cx, 1);
    await prompt(server, promptParams("a completely different topic"), cx, 2);

    expect(server.sessionTitles.get("sess_ts")).toBe("original title source");
    expect(titles).toEqual(["original title source"]);
    expect(titlePersists).toHaveLength(1);
  });

  it("non-eligible (resumed) sessions never get an auto-title", async () => {
    const server = setup(
      scriptedBackend(() => [
        { type: "turn.started" },
        { type: "turn.completed", payload: { resultType: "success" } },
      ]),
    );
    const { cx, titles } = collectCx();

    const result = await prompt(server, promptParams("post-resume message"), cx, 1);

    expect(result).toEqual({ stopReason: "end_turn" });
    expect(server.sessionTitles.size).toBe(0);
    expect(titles).toEqual([]);
    expect(titlePersists).toHaveLength(0);
  });

  it("truncates multi-line first prompts to the first non-empty line, 80 chars", async () => {
    const server = setup(
      scriptedBackend(() => [
        { type: "turn.started" },
        { type: "turn.completed", payload: { resultType: "success" } },
      ]),
    );
    server.titleEligibleSessions.add("sess_ts");
    const { cx } = collectCx();

    const long = "x".repeat(100);
    await prompt(server, promptParams(`\n${long}\nignored second line`), cx, 1);

    expect(server.sessionTitles.get("sess_ts")).toBe("x".repeat(80));
  });
});
