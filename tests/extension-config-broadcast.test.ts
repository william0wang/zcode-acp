/**
 * Extension settings-method broadcasts (setModel / setThoughtLevel / setMode):
 * a switch from ANY attached client must refresh every other client's
 * dropdown — historically these handlers emitted nothing (or initiator-only),
 * leaving the CLI window stale after a phone-side switch.
 *
 * Handlers are invoked through the broadcast proxy exactly as index.ts wires
 * them, which also pins the no-double-delivery contract: the proxy's notify
 * already fans out to every client, so an "others" leg on top of it would
 * deliver every config update twice.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/runtime-model.js", () => ({
  applyModelSwitch: vi.fn().mockResolvedValue(true),
}));

import { setMode, setModel, setThoughtLevel } from "../src/handlers/extensions.js";
import { emitConfigOptionUpdate } from "../src/config/options.js";
import { ZcodeAcpServer } from "../src/server.js";

const SID_A = "acp-ext-1";
const SID_Z = "zc-ext-1";

interface NotifyCall {
  method: string;
  params: Record<string, unknown>;
}

function recordingClient() {
  const received: NotifyCall[] = [];
  return {
    received,
    client: {
      notify: async (method: string, params: unknown) => {
        received.push({ method, params: params as Record<string, unknown> });
      },
      request: async () => {
        throw new Error("no server→client requests expected");
      },
    },
  };
}

/** Real server with a fake backend answering session/read like the live one. */
function boot() {
  const server = new ZcodeAcpServer();
  server.registerSession(SID_A, SID_Z);
  server.backend = {
    isDead: false,
    request: async (_id: number, method: string) => {
      if (method === "session/read") {
        return {
          result: {
            settings: {
              model: { current: { providerId: "zai", modelId: "glm-4.6" } },
              mode: { current: "plan" },
              thoughtLevel: { current: "high" },
            },
          },
        };
      }
      return { result: {} };
    },
  } as unknown as NonNullable<ZcodeAcpServer["backend"]>;
  const a = recordingClient();
  const b = recordingClient();
  server.clients.add(a.client);
  server.clients.add(b.client);
  return { server, a, b };
}

function sessionUpdates(c: { received: NotifyCall[] }) {
  return c.received
    .filter((r) => r.method === "session/update")
    .map((r) => r.params.update as Record<string, unknown>);
}

describe("extension settings broadcasts", () => {
  it("setThoughtLevel emits exactly one config_option_update per attached client", async () => {
    const { server, a, b } = boot();
    await setThoughtLevel(
      server,
      { sessionId: SID_A, thoughtLevel: "high" },
      server.clients.broadcast(),
    );
    for (const c of [a, b]) {
      const updates = sessionUpdates(c);
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ sessionUpdate: "config_option_update" });
      const options = updates[0]!.configOptions as Array<{ id: string; currentValue?: string }>;
      expect(options.find((o) => o.id === "thought")?.currentValue).toBe("high");
    }
  });

  it("reaches clients holding the conversation under a SECOND alias (one copy per alias)", async () => {
    // Two clients may hold different acpSids for one backend conversation and
    // route by payload sessionId — the proxy fan-out must loop sessionAliases,
    // not just emit under the switching client's id.
    const { server, a, b } = boot();
    const altSid = "acp-ext-1-alt";
    server.registerSession(altSid, SID_Z);
    await setThoughtLevel(
      server,
      { sessionId: SID_A, thoughtLevel: "high" },
      server.clients.broadcast(),
    );
    for (const c of [a, b]) {
      const calls = c.received.filter((r) => r.method === "session/update");
      expect(calls).toHaveLength(2);
      expect(calls.map((r) => r.params.sessionId)).toEqual([SID_A, altSid]);
      for (const r of calls) {
        expect(r.params.update).toMatchObject({ sessionUpdate: "config_option_update" });
      }
    }
  });

  it("setModel emits config_option_update + usage_update once per client (no duplicates)", async () => {
    const { server, a, b } = boot();
    await setModel(
      server,
      { sessionId: SID_A, modelId: "zai\\glm-4.6" },
      server.clients.broadcast(),
    );
    for (const c of [a, b]) {
      const updates = sessionUpdates(c);
      expect(updates.map((u) => u.sessionUpdate)).toEqual(["config_option_update", "usage_update"]);
      const options = updates[0]!.configOptions as Array<{ id: string; currentValue?: string }>;
      expect(options.find((o) => o.id === "model")?.currentValue).toBe("zai\\glm-4.6");
    }
  });

  it("setMode emits config_option_update + current_mode_update once per client and mirrors lastMode", async () => {
    const { server, a, b } = boot();
    await setMode(server, { sessionId: SID_A, mode: "plan" }, server.clients.broadcast());
    for (const c of [a, b]) {
      const updates = sessionUpdates(c);
      expect(updates.map((u) => u.sessionUpdate)).toEqual([
        "config_option_update",
        "current_mode_update",
      ]);
    }
    expect(server.lastMode.get(SID_A)).toBe("plan");
  });

  it("a real per-connection cx keeps the initiator+others split (no skip, no dupe)", async () => {
    const { server } = boot();
    const initiator = recordingClient();
    const other = recordingClient();
    initiator.client.connectionContext = { id: "initiator-root" };
    server.clients.add(initiator.client);
    server.clients.add(other.client);
    await emitConfigOptionUpdate(
      server,
      initiator.client as unknown as acp.AgentContext,
      SID_A,
      SID_Z,
      "thought",
    );
    expect(initiator.received).toHaveLength(1);
    expect(other.received).toHaveLength(1);
    expect(sessionUpdates(other)[0]).toMatchObject({ sessionUpdate: "config_option_update" });
  });
});
