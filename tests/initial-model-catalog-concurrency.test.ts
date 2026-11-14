import * as acp from "@agentclientprotocol/sdk";
import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock("../src/config/initial-model-catalog.js", () => ({
  probeInitialModelCatalog: state.probe,
}));
vi.mock("../src/lazy-sessions.js", () => ({
  rememberLazySession: () => {},
  lookupLazySession: () => undefined,
}));
vi.mock("../src/tasks-index.js", () => ({ reviveTombstonesOnActivity: async () => 0 }));
import { newSession } from "../src/handlers/session.js";
import { withReplayBatch } from "../src/handlers/io.js";
import { ZcodeAcpServer } from "../src/server.js";
import { buildAgentApp } from "../src/index.js";
import { trackConnections } from "../src/remote/broadcast.js";
const snapshot = {
  session: { sessionId: "probe" },
  settings: {
    model: {
      current: { providerId: "p", modelId: "m" },
      available: [{ ref: { providerId: "p", modelId: "m" } }],
    },
  },
};
it("returns immediately, deduplicates per cwd and invalidates late generations", async () => {
  state.probe.mockReset();
  const releases: Array<(value: typeof snapshot) => void> = [];
  state.probe.mockImplementation(() => new Promise((resolve) => releases.push(resolve)));
  const server = new ZcodeAcpServer();
  const cwd = process.env.HOME!;
  await Promise.all([
    newSession(server, { cwd, mcpServers: [] }),
    newSession(server, { cwd, mcpServers: [] }),
  ]);
  await vi.waitFor(() => expect(state.probe).toHaveBeenCalledTimes(1));
  await newSession(server, { cwd: process.cwd(), mcpServers: [] });
  await vi.waitFor(() => expect(state.probe).toHaveBeenCalledTimes(2));
  releases[0]!(snapshot);
  await vi.waitFor(() => expect(server.initialCatalogCache.has(cwd)).toBe(true));
  const result = await newSession(server, { cwd, mcpServers: [] });
  expect(result.configOptions?.find((o) => o.id === "model")).toMatchObject({
    currentValue: "p\\m",
  });
  expect(state.probe).toHaveBeenCalledTimes(2);
  server.resetBackendGeneration();
  releases[1]!(snapshot);
  await new Promise((resolve) => setImmediate(resolve));
  expect(server.initialCatalogCache.size).toBe(0);
  server.dispose();
});

function client() {
  const notify = vi.fn(async (_method: string, _params?: unknown) => {});
  return { notify, context: { notify, connectionContext: {} } as unknown as acp.AgentContext };
}
function deferred() {
  let release!: (value: typeof snapshot | null) => void;
  const promise = new Promise<typeof snapshot | null>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
it("updates each cold session after its response using the shared verified flight", async () => {
  state.probe.mockReset();
  const probe = deferred();
  state.probe.mockReturnValue(probe.promise);
  const server = new ZcodeAcpServer();
  const a = client();
  const b = client();
  const cwd = process.env.HOME!;
  const one = await newSession(server, { cwd, mcpServers: [] }, a.context);
  const two = await newSession(server, { cwd, mcpServers: [] }, b.context);
  expect(a.notify).not.toHaveBeenCalled();
  expect(b.notify).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(state.probe).toHaveBeenCalledTimes(1));
  probe.release(snapshot);
  await vi.waitFor(() => expect(a.notify).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(b.notify).toHaveBeenCalledOnce());
  for (const [c, sid] of [
    [a, one.sessionId],
    [b, two.sessionId],
  ] as const) {
    expect(c.notify).toHaveBeenCalledWith(
      "session/update",
      expect.objectContaining({
        sessionId: sid,
        update: expect.objectContaining({
          sessionUpdate: "config_option_update",
          configOptions: expect.arrayContaining([
            expect.objectContaining({ id: "model", currentValue: "p\\m" }),
          ]),
        }),
      }),
    );
  }
  server.dispose();
});
it.each(["generation", "cwd", "selection", "closed", "disposed", "failure"])(
  "drops a late update after %s",
  async (scenario) => {
    state.probe.mockReset();
    const probe = deferred();
    state.probe.mockReturnValue(probe.promise);
    const server = new ZcodeAcpServer();
    const c = client();
    const cwd = process.env.HOME!;
    const result = await newSession(server, { cwd, mcpServers: [] }, c.context);
    await vi.waitFor(() => expect(state.probe).toHaveBeenCalledOnce());
    if (scenario === "generation") server.resetBackendGeneration();
    if (scenario === "cwd") server.sessionCwds.set(result.sessionId, "/other");
    if (scenario === "selection")
      server.pendingSessions.get(result.sessionId)!.creating = new Promise(() => {});
    if (scenario === "closed") server.pendingSessions.delete(result.sessionId);
    if (scenario === "disposed") server.dispose();
    probe.release(scenario === "failure" ? null : snapshot);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(c.notify).not.toHaveBeenCalled();
    server.dispose();
  },
);
it("does not notify a disconnected originating connection", async () => {
  state.probe.mockReset();
  const probe = deferred();
  state.probe.mockReturnValue(probe.promise);
  const server = new ZcodeAcpServer();
  const c = client();
  const registered = c.context as unknown as Parameters<typeof server.clients.add>[0];
  server.clients.add(registered);
  await newSession(server, { cwd: process.env.HOME!, mcpServers: [] }, c.context);
  await vi.waitFor(() => expect(state.probe).toHaveBeenCalledOnce());
  server.clients.remove(registered);
  probe.release(snapshot);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(c.notify).not.toHaveBeenCalled();
  server.dispose();
});

it("rechecks selection after a notification waits behind a replay", async () => {
  state.probe.mockReset();
  const probe = deferred();
  state.probe.mockReturnValue(probe.promise);
  const server = new ZcodeAcpServer();
  const c = client();
  const session = await newSession(server, { cwd: process.env.HOME!, mcpServers: [] }, c.context);
  await vi.waitFor(() => expect(state.probe).toHaveBeenCalledOnce());
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const replay = withReplayBatch(session.sessionId, async () => blocked);
  probe.release(snapshot);
  await vi.waitFor(() => expect(server.initialCatalogCache.size).toBe(1));
  await new Promise((resolve) => setTimeout(resolve, 30));
  server.pendingSessions.get(session.sessionId)!.creating = new Promise(() => {});
  unblock();
  await replay;
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(c.notify).not.toHaveBeenCalled();
  server.dispose();
});
it("delivers separate workspace results only to their own sessions", async () => {
  state.probe.mockReset();
  const a = deferred();
  const b = deferred();
  state.probe.mockImplementation((cwd: string) =>
    cwd === process.env.HOME ? a.promise : b.promise,
  );
  const server = new ZcodeAcpServer();
  const ca = client();
  const cb = client();
  const sa = await newSession(server, { cwd: process.env.HOME!, mcpServers: [] }, ca.context);
  const sb = await newSession(server, { cwd: process.cwd(), mcpServers: [] }, cb.context);
  await vi.waitFor(() => expect(state.probe).toHaveBeenCalledTimes(2));
  b.release(snapshot);
  await vi.waitFor(() => expect(cb.notify).toHaveBeenCalledOnce());
  expect(ca.notify).not.toHaveBeenCalled();
  expect(cb.notify.mock.calls[0]?.[1]).toMatchObject({ sessionId: sb.sessionId });
  a.release(snapshot);
  await vi.waitFor(() => expect(ca.notify).toHaveBeenCalledOnce());
  expect(ca.notify.mock.calls[0]?.[1]).toMatchObject({ sessionId: sa.sessionId });
  server.dispose();
});

it("writes the session/new response before the catalog update through the ACP transport", async () => {
  state.probe.mockReset();
  const probe = deferred();
  state.probe.mockReturnValue(probe.promise);
  const server = new ZcodeAcpServer();
  const app = buildAgentApp(server, []);
  trackConnections(app, server.clients);
  const incoming = new TransformStream<Uint8Array, Uint8Array>();
  const messages: Array<Record<string, unknown>> = [];
  let responseEntered!: () => void;
  const responseStarted = new Promise<void>((resolve) => {
    responseEntered = resolve;
  });
  let releaseResponse!: () => void;
  const responseBlocked = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const outgoing = new WritableStream<Uint8Array>({
    async write(bytes) {
      const message = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      if (message.id === 91) {
        responseEntered();
        await responseBlocked;
      }
      messages.push(message);
    },
  });
  const notify = vi.spyOn(acp.AgentContext.prototype, "notify");
  const connection = app.connect(acp.ndJsonStream(outgoing, incoming.readable));
  const writer = incoming.writable.getWriter();
  try {
    await writer.write(
      new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 91,
          method: "session/new",
          params: { cwd: process.env.HOME!, mcpServers: [] },
        }) + "\n",
      ),
    );
    await responseStarted;
    await vi.waitFor(() => expect(state.probe).toHaveBeenCalledOnce());
    probe.release(snapshot);
    await vi.waitFor(() => expect(server.initialCatalogCache.size).toBe(1));
    await vi.waitFor(() =>
      expect(
        notify.mock.calls.some(
          ([method, params]) =>
            method === "session/update" &&
            (params as { update?: { sessionUpdate?: string } })?.update?.sessionUpdate ===
              "config_option_update",
        ),
      ).toBe(true),
    );
    expect(messages.some((message) => message.method === "session/update")).toBe(false);
    releaseResponse();
    await vi.waitFor(() =>
      expect(
        messages.some(
          (message) =>
            message.method === "session/update" &&
            (message.params as { update?: { sessionUpdate?: string } }).update?.sessionUpdate ===
              "config_option_update",
        ),
      ).toBe(true),
    );
    const responseIndex = messages.findIndex((message) => message.id === 91);
    const updateIndex = messages.findIndex(
      (message) =>
        message.method === "session/update" &&
        (message.params as { update?: { sessionUpdate?: string } }).update?.sessionUpdate ===
          "config_option_update",
    );
    expect(responseIndex).toBeGreaterThanOrEqual(0);
    expect(updateIndex).toBeGreaterThan(responseIndex);
    expect((messages[updateIndex]!.params as { sessionId: string }).sessionId).toBe(
      (messages[responseIndex]!.result as { sessionId: string }).sessionId,
    );
  } finally {
    releaseResponse();
    writer.releaseLock();
    connection.close();
    notify.mockRestore();
    server.dispose();
  }
});
