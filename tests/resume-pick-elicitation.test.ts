/**
 * Regression: the `/resume` picker's `elicitation/create` params must carry a
 * session scope. Zed (1.18.1) validates the request against the ACP schema
 * and answers -32602 ("data did not match any variant of untagged enum
 * ElicitationMode") when neither sessionId nor requestId is present — the
 * failed request surfaced to the user as a bare "resume cancelled".
 *
 * The client mock below re-validates the exact wire params with the SDK's own
 * generated zod schema, mirroring the Rust deserializer that rejected them.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import { zCreateElicitationRequest } from "../node_modules/@agentclientprotocol/sdk/dist/schema/zod.gen.js";
import { askSessionPick } from "../src/handlers/server-requests.js";
import { ZcodeAcpServer } from "../src/server.js";

/**
 * A schema-strict client: `elicitation/create` params that do not parse are
 * answered with a rejection (the JSON-RPC error path requestWithTimeout maps
 * to null). Everything else succeeds.
 */
function strictElicitationClient(onParams: (params: unknown) => void): acp.AgentContext {
  return {
    notify: async () => {},
    request: async (method: string, params: never) => {
      if (method !== "elicitation/create") return {};
      onParams(params);
      const parsed = zCreateElicitationRequest.safeParse(params);
      if (!parsed.success) throw new Error("Invalid params");
      return { action: "accept", content: { session: "ztarget" } };
    },
  } as unknown as acp.AgentContext;
}

describe("askSessionPick elicitation wire format", () => {
  it("sends a session-scoped form a schema-strict client accepts", async () => {
    const server = new ZcodeAcpServer();
    server.mergeClientCapabilities({ elicitation: { form: {} } });
    const seen: unknown[] = [];
    const cx = strictElicitationClient((p) => seen.push(p));

    const picked = await askSessionPick(server, cx, "acp_thread_1", [
      { sessionId: "ztarget", label: "a session · 2026-09-07 00:00" },
      { sessionId: "zother", label: "another · 2026-09-06 12:00" },
    ]);

    expect(seen).toHaveLength(1);
    expect(picked).toBe("ztarget");
    // The scope must name the editor thread the picker was opened from.
    expect(seen[0]).toMatchObject({ mode: "form", sessionId: "acp_thread_1" });
  });

  it("returns null (no adoption) when the client rejects the params", async () => {
    const server = new ZcodeAcpServer();
    server.mergeClientCapabilities({ elicitation: { form: {} } });
    const cx = {
      notify: async () => {},
      request: async () => {
        throw new Error("Invalid params");
      },
    } as unknown as acp.AgentContext;

    const picked = await askSessionPick(server, cx, "acp_thread_1", [
      { sessionId: "ztarget", label: "a session" },
    ]);
    expect(picked).toBeNull();
  });
});
