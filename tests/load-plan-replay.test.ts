/**
 * session/load must emit the CURRENT todo list as a PlanUpdate on every load.
 *
 * The shared per-session differ only fires on plan CHANGE: once any client
 * attached and its diff aligned `lastPlanSig`, a re-attaching client (the
 * mobile app always re-attaches) would never learn the plan a previous
 * client already saw. The load path therefore runs a throwaway differ whose
 * "__none__" sentinel makes diffPlan always emit — while still running the
 * shared differ's full diff for its mark-seen side effect.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import { loadSession } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async () => true,
  updateSessionTitle: async () => true,
}));

const TODOS = [{ content: "wire the fix", status: "in_progress", priority: "high" }];

function fakeBackend(): ZcodeBackend {
  return {
    isDead: false,
    request: async (_id: number, method: string) => {
      switch (method) {
        case "workspace/updateProviderRegistry":
        case "session/resume":
          return { result: {} };
        case "session/subscribe":
          return { result: { eventSeq: 0 } };
        case "session/read":
          return { result: { projection: { status: "idle" }, todos: TODOS } };
        case "session/messages":
          return {
            result: {
              messages: [
                { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
              ],
            },
          };
        default:
          return { result: {} };
      }
    },
    send: () => {},
    pollServerRequests: () => [],
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
}

/** cx that records every session/update notification. */
function collectCx(): { cx: acp.AgentContext; updates: unknown[] } {
  const updates: unknown[] = [];
  const cx = {
    notify: async (_method: string, params: Record<string, unknown>) => {
      updates.push(params);
    },
  } as unknown as acp.AgentContext;
  return { cx, updates };
}

const planUpdates = (updates: unknown[]) =>
  updates.filter(
    (u) => (u as { update?: { sessionUpdate?: string } }).update?.sessionUpdate === "plan",
  );

describe("session/load plan replay", () => {
  it("emits a PlanUpdate on every load, even when the shared differ already saw the plan", async () => {
    const server = new ZcodeAcpServer();
    server.backend = fakeBackend();
    server.registerSession("s-plan", "sess_plan");

    const first = collectCx();
    await loadSession(server, { sessionId: "s-plan" } as acp.LoadSessionRequest, first.cx);
    expect(planUpdates(first.updates)).toHaveLength(1);

    // Re-attach: the shared differ's lastPlanSig already matches, but the
    // re-attaching client must still learn the current todos.
    const second = collectCx();
    await loadSession(server, { sessionId: "s-plan" } as acp.LoadSessionRequest, second.cx);
    const plans = planUpdates(second.updates);
    expect(plans).toHaveLength(1);
    expect(
      (plans[0] as { update: { entries: Array<{ content: string }> } }).update.entries,
    ).toEqual(
      [{ content: "wire the fix", status: "in_progress", priority: "high" }].map((e) =>
        expect.objectContaining(e),
      ),
    );
  });
});
