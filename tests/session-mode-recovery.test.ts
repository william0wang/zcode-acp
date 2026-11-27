/**
 * Internal resumes announce the recovered mode to attached clients. The
 * backend owns the execution state throughout recovery.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeEvent } from "../src/backend/types.js";
import { publishResolvedMode } from "../src/config/options.js";
import { BackgroundTaskListener } from "../src/handlers/background-tasks.js";
import { emitModeIfChanged, reloadBackendSession } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async () => true,
  updateSessionTitle: async () => true,
}));

vi.mock("../src/lazy-sessions.js", () => ({
  rememberLazySession: () => {},
  recordMaterializedSession: () => {},
  recordAdvertisedModel: () => {},
  lookupLazySession: () => undefined,
}));

interface BackendSpec {
  resumeResult?: unknown;
  readResult?: unknown;
  readError?: string;
}

function makeBackend(spec: BackendSpec): { backend: ZcodeBackend; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const backend = {
    isDead: false,
    request: async (_id: number, method: string) => {
      counts.set(method, (counts.get(method) ?? 0) + 1);
      switch (method) {
        case "session/resume":
          return { result: spec.resumeResult ?? {} };
        case "workspace/updateProviderRegistry":
          return { result: {} };
        case "session/read":
          if (spec.readError) return { error: { message: spec.readError } };
          return { result: spec.readResult ?? { settings: {} } };
        case "session/messages":
          return { result: { messages: [] } };
        default:
          return { result: {} };
      }
    },
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
  return { backend, counts };
}

/** A fake attached client whose notifications are recorded per sessionId. */
function fakeClient(): {
  client: acp.AgentContext;
  calls: Array<{ sessionId: string; update: acp.SessionUpdate }>;
} {
  const calls: Array<{ sessionId: string; update: acp.SessionUpdate }> = [];
  const client = {
    notify: async (_method: string, params: { sessionId: string; update: acp.SessionUpdate }) => {
      calls.push(params);
    },
    request: async () => ({}),
  } as unknown as acp.AgentContext;
  return { client, calls };
}

function makeServer(spec: BackendSpec): {
  server: ZcodeAcpServer;
  counts: Map<string, number>;
  calls: Array<{ sessionId: string; update: acp.SessionUpdate }>;
} {
  const server = new ZcodeAcpServer();
  const { backend, counts } = makeBackend(spec);
  server.backend = backend;
  server.registerSession("sess_acp", "sess_race");
  server.sessionCwds.set("sess_acp", "/tmp/ws");
  server.markBackendLoaded("sess_acp");
  const { client, calls } = fakeClient();
  server.clients.add(client);
  return { server, counts, calls };
}

describe("publishResolvedMode (the recovery broadcast primitive)", () => {
  it("presents a background Plan change once per alias with the underlying base preserved", async () => {
    const { server, calls } = makeServer({});
    server.registerSession("sess_other", "sess_race");
    const listener = new BackgroundTaskListener(server, "sess_race");
    listener.handleEvent({
      sessionId: "sess_race",
      type: "session.updated",
      seq: 1,
      payload: { mode: "build", planEnabled: true },
    } as ZcodeEvent);
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    expect(server.seededBaseModeOf("sess_race")).toBe("build");
    for (const sid of ["sess_acp", "sess_other"]) {
      expect(server.lastMode.get(sid)).toBe("plan");
      expect(calls.filter((c) => c.sessionId === sid).map((c) => c.update.sessionUpdate)).toEqual([
        "config_option_update",
        "current_mode_update",
      ]);
    }
  });

  it("sends ONE config_option_update + ONE current_mode_update per alias, then mirrors lastMode", async () => {
    const { server, calls } = makeServer({});
    server.registerSession("sess_acp_2", "sess_race"); // second alias of the SAME session
    await publishResolvedMode(server, server.clients.broadcast(), "sess_acp", "sess_race", {
      effective: "build",
      base: "build",
      plan: false,
    });
    const configUpdates = calls.filter((c) => c.update.sessionUpdate === "config_option_update");
    const modeUpdates = calls.filter((c) => c.update.sessionUpdate === "current_mode_update");
    expect(configUpdates.map((c) => c.sessionId).sort()).toEqual(["sess_acp", "sess_acp_2"]);
    expect(modeUpdates.map((c) => c.sessionId).sort()).toEqual(["sess_acp", "sess_acp_2"]);
    for (const c of modeUpdates) {
      expect(c.update).toEqual({ sessionUpdate: "current_mode_update", currentModeId: "build" });
    }
    expect(server.lastMode.get("sess_acp")).toBe("build");
  });

  it("never sends a session/setMode (a recovery only reports)", async () => {
    const { server, counts, calls } = makeServer({});
    await publishResolvedMode(server, server.clients.broadcast(), "sess_acp", "sess_race", {
      effective: "edit",
      base: "edit",
      plan: false,
    });
    expect(counts.get("session/setMode") ?? 0).toBe(0);
    expect(calls.filter((c) => c.update.sessionUpdate === "current_mode_update")).toHaveLength(1);
  });
});

describe("reloadBackendSession (runtime-rebuild recovery)", () => {
  it("concurrent reloads publish one pair per alias from a single backend resume", async () => {
    const { server, calls, counts } = makeServer({
      resumeResult: { settings: { mode: { current: "build", planEnabled: true } } },
    });
    server.registerSession("sess_other", "sess_race");
    await Promise.all(
      ["sess_acp", "sess_other"].map((sid) => reloadBackendSession(server, sid, "sess_race")),
    );
    expect(counts.get("session/resume")).toBe(1);
    expect(counts.get("session/setMode") ?? 0).toBe(0);
    for (const sid of ["sess_acp", "sess_other"]) {
      expect(
        calls.filter(
          (c) => c.sessionId === sid && c.update.sessionUpdate === "config_option_update",
        ),
      ).toHaveLength(1);
      expect(
        calls.filter(
          (c) => c.sessionId === sid && c.update.sessionUpdate === "current_mode_update",
        ),
      ).toEqual([
        { sessionId: sid, update: { sessionUpdate: "current_mode_update", currentModeId: "plan" } },
      ]);
    }
  });

  it("broadcasts the confirmed mode when it differs from the last advertised value", async () => {
    const { server, calls, counts } = makeServer({
      resumeResult: {
        settings: { mode: { current: "edit", planEnabled: false } },
      },
    });
    server.lastMode.set("sess_acp", "build"); // what the client last saw
    await reloadBackendSession(server, "sess_acp", "sess_race");
    const modeUpdates = calls.filter((c) => c.update.sessionUpdate === "current_mode_update");
    expect(modeUpdates).toHaveLength(1);
    expect(modeUpdates[0]!.update).toEqual({
      sessionUpdate: "current_mode_update",
      currentModeId: "edit",
    });
    expect(server.lastMode.get("sess_acp")).toBe("edit");
    // The recovery reports — it never switches.
    expect(counts.get("session/setMode") ?? 0).toBe(0);
  });

  it("stays silent when the recovered mode equals the last advertised value", async () => {
    const { server, calls } = makeServer({
      resumeResult: {
        settings: { mode: { current: "build", planEnabled: false } },
      },
    });
    server.lastMode.set("sess_acp", "build");
    await reloadBackendSession(server, "sess_acp", "sess_race");
    expect(calls.filter((c) => c.update.sessionUpdate === "current_mode_update")).toHaveLength(0);
    // The mirror still settles on the confirmed value.
    expect(server.lastMode.get("sess_acp")).toBe("build");
  });

  it("an unconfirmable recovered mode leaves the display as-is", async () => {
    const { server, calls } = makeServer({
      resumeResult: { settings: {} }, // base-only, no Plan evidence → withheld
    });
    server.lastMode.set("sess_acp", "build");
    await reloadBackendSession(server, "sess_acp", "sess_race");
    expect(calls.filter((c) => c.update.sessionUpdate === "current_mode_update")).toHaveLength(0);
    // lastMode keeps the client's existing display.
    expect(server.lastMode.get("sess_acp")).toBe("build");
  });

  it("a base-only resume snapshot (no planEnabled on the wire) publishes the base mode", async () => {
    // Real wire shape: settings.mode carries `current` alone, so the Plan
    // switch is unknown after every runtime rebuild. The retired "plan" must
    // not answer, but the base is published — not withheld (0.95.0 regression).
    const { server, calls } = makeServer({
      resumeResult: { settings: { mode: { current: "build" } } },
      readResult: { settings: { mode: { current: "build" } } },
    });
    server.lastMode.set("sess_acp", "plan"); // what the client saw before the reload
    await reloadBackendSession(server, "sess_acp", "sess_race");
    const modeUpdates = calls.filter((c) => c.update.sessionUpdate === "current_mode_update");
    expect(modeUpdates).toHaveLength(1);
    expect(modeUpdates[0]!.update).toEqual({
      sessionUpdate: "current_mode_update",
      currentModeId: "build",
    });
    expect(server.lastMode.get("sess_acp")).toBe("build");
    expect(server.planStateOf("sess_race")).toBeUndefined();
  });
});

describe("emitModeIfChanged (turn-end refresh)", () => {
  it("publishes the confirmed change once per alias set", async () => {
    const { server, calls } = makeServer({
      readResult: { settings: { mode: { current: "edit" } } },
    });
    server.notePlanState("sess_race", false);
    server.lastMode.set("sess_acp", "build");
    await emitModeIfChanged(server, server.clients.broadcast(), "sess_acp", "sess_race");
    const modeUpdates = calls.filter((c) => c.update.sessionUpdate === "current_mode_update");
    expect(modeUpdates).toHaveLength(1);
    expect(modeUpdates[0]!.update).toEqual({
      sessionUpdate: "current_mode_update",
      currentModeId: "edit",
    });
    expect(server.lastMode.get("sess_acp")).toBe("edit");
  });

  it("a failed read ENDS the refresh — no notifications, display kept", async () => {
    const { server, calls } = makeServer({ readError: "timeout" });
    server.lastMode.set("sess_acp", "build");
    await emitModeIfChanged(server, server.clients.broadcast(), "sess_acp", "sess_race");
    expect(calls.filter((c) => c.update.sessionUpdate === "current_mode_update")).toHaveLength(0);
    expect(calls.filter((c) => c.update.sessionUpdate === "config_option_update")).toHaveLength(0);
    expect(server.lastMode.get("sess_acp")).toBe("build");
  });

  it("a later valid read confirms the change after a failed check (display kept, then notified)", async () => {
    // Spec scenario: the client last saw build; a turn-end check FAILS
    // (display kept); the NEXT sync confirms edit and notifies.
    const spec: BackendSpec = { readError: "timeout" };
    const { server, calls } = makeServer(spec);
    server.notePlanState("sess_race", false);
    server.lastMode.set("sess_acp", "build");
    await emitModeIfChanged(server, server.clients.broadcast(), "sess_acp", "sess_race");
    expect(server.lastMode.get("sess_acp")).toBe("build"); // first check kept the display
    spec.readError = undefined;
    spec.readResult = { settings: { mode: { current: "edit" } } };
    await emitModeIfChanged(server, server.clients.broadcast(), "sess_acp", "sess_race");
    const modeUpdates = calls.filter((c) => c.update.sessionUpdate === "current_mode_update");
    expect(modeUpdates).toHaveLength(1);
    expect(modeUpdates[0]!.update).toEqual({
      sessionUpdate: "current_mode_update",
      currentModeId: "edit",
    });
  });
});

describe("resident reconnect (alreadyLive load)", () => {
  it("an unchanged Plan record survives a resident reconnect and the display follows the runtime", async () => {
    // alreadyLive: no resume flight → no plan invalidation. The confirmed
    // Plan state answers for the SAME runtime that is still resident.
    const { server } = makeServer({
      readResult: { settings: { mode: { current: "build" } } },
    });
    server.notePlanState("sess_race", true);
    server.lastMode.set("sess_acp", "plan");
    const resolution = await import("../src/config/options.js").then((m) =>
      m.resolveSessionMode(server, "sess_race"),
    );
    expect(resolution.effective).toBe("plan");
    expect(server.lastMode.get("sess_acp")).toBe("plan");
  });
});
