/**
 * server.ts tests — verify the `initialize` response shape, with focus on the
 * ACP registry's authentication validation.
 *
 * The registry CI (verify_agents.py --auth-check) spawns the server with an
 * isolated HOME (no credentials) and asserts that `initialize` returns a
 * non-empty `authMethods` array where at least one method has type "agent" or
 * "terminal" (type omitted defaults to "agent"). An empty array is rejected.
 * https://github.com/agentclientprotocol/registry/blob/main/.github/workflows/client.py
 */

import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import { ZcodeAcpServer } from "../src/server.js";

/** Minimal initialize params matching the ACP handshake shape. */
function initParams(): acp.InitializeRequest {
  return {
    protocolVersion: 1,
    clientInfo: { name: "test-client", version: "0.0.0" },
    clientCapabilities: {},
  } as acp.InitializeRequest;
}

describe("ZcodeAcpServer.initialize", () => {
  it("returns protocol version 1 and agent info", async () => {
    const server = new ZcodeAcpServer();
    const resp = await server.initialize(initParams());
    expect(resp.protocolVersion).toBe(1);
    expect(resp.agentInfo.name).toBe("zcode-acp-server");
  });

  it("advertises loadSession + list/resume/fork session capabilities", async () => {
    const server = new ZcodeAcpServer();
    const resp = await server.initialize(initParams());
    expect(resp.agentCapabilities?.loadSession).toBe(true);
    expect(resp.agentCapabilities?.sessionCapabilities?.list).toBeDefined();
    expect(resp.agentCapabilities?.sessionCapabilities?.resume).toBeDefined();
    expect(resp.agentCapabilities?.sessionCapabilities?.fork).toBeDefined();
  });

  // Registry CI gate: rejects `authMethods: []` with "No authMethods in response".
  it("returns a non-empty authMethods array", async () => {
    const server = new ZcodeAcpServer();
    const resp = await server.initialize(initParams());
    expect(resp.authMethods).toBeDefined();
    expect(resp.authMethods!.length).toBeGreaterThan(0);
  });

  // Registry CI gate: ≥1 method must be recognisable as agent/terminal type.
  // AuthMethodAgent has no `type` field — omitted defaults to "agent".
  it("advertises at least one agent-type auth method (registry requirement)", async () => {
    const server = new ZcodeAcpServer();
    const resp = await server.initialize(initParams());
    const methods = resp.authMethods!.map((m) => {
      const obj = m as { type?: string };
      return obj.type ?? "agent"; // omitted type defaults to "agent"
    });
    expect(methods).toContain("agent");
  });

  it("the auth method has the required id + name fields", async () => {
    const server = new ZcodeAcpServer();
    const resp = await server.initialize(initParams());
    for (const m of resp.authMethods!) {
      const method = m as { id?: string; name?: string };
      expect(method.id).toBeTruthy();
      expect(method.name).toBeTruthy();
    }
  });

  // The registry CI runs initialize with an empty HOME and no config.json —
  // initialize must NOT eagerly spawn the backend or read credentials.
  it("does not spawn the backend during initialize", async () => {
    const server = new ZcodeAcpServer();
    await server.initialize(initParams());
    expect(server.backend).toBeNull();
  });
});

describe("ZcodeAcpServer discovery summaries", () => {
  it("touchSessionSummary bumps updatedAt and keeps the title sticky", async () => {
    const server = new ZcodeAcpServer();
    server.touchSessionSummary("s1");
    expect(server.sessionSummaries.get("s1")?.title).toBeUndefined();

    server.touchSessionSummary("s1", "My title");
    const titled = server.sessionSummaries.get("s1")!;
    expect(titled.title).toBe("My title");

    await new Promise((resolve) => setTimeout(resolve, 5));
    server.touchSessionSummary("s1");
    const touched = server.sessionSummaries.get("s1")!;
    expect(touched.title).toBe("My title");
    expect(touched.updatedAt).toBeGreaterThan(titled.updatedAt);
  });

  it("plain touches do not mark activity; a title does", () => {
    const server = new ZcodeAcpServer();
    server.registerSession("s-artifact", "zc1");
    expect(server.sessionSummaries.get("s-artifact")?.hasActivity).toBeFalsy();

    server.touchSessionSummary("s-artifact");
    expect(server.sessionSummaries.get("s-artifact")?.hasActivity).toBeFalsy();

    server.touchSessionSummary("s-artifact", "Stored title");
    expect(server.sessionSummaries.get("s-artifact")?.hasActivity).toBe(true);
  });

  it("markSessionActive sets the flag, bumps updatedAt, and keeps the title", async () => {
    const server = new ZcodeAcpServer();
    server.registerSession("s1", "zc1");
    server.touchSessionSummary("s1", "My title");
    const before = server.sessionSummaries.get("s1")!;

    await new Promise((resolve) => setTimeout(resolve, 5));
    server.markSessionActive("s1");
    const after = server.sessionSummaries.get("s1")!;
    expect(after.hasActivity).toBe(true);
    expect(after.title).toBe("My title");
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt);
  });

  it("workspaceLabel prefers a known session cwd and falls back to process cwd", () => {
    const server = new ZcodeAcpServer();
    expect(server.workspaceLabel()).toBe(process.cwd());
    server.sessionCwds.set("s1", "/tmp/proj");
    expect(server.workspaceLabel()).toBe("/tmp/proj");
  });
});
