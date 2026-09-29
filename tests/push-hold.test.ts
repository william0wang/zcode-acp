/**
 * Offline interaction hold (push-backend-requirements §6) — the four required
 * regression scenarios, driven through the real broadcast registry and
 * requestWithTimeout:
 *
 *   1. zero clients + push ACTIVE  → the wait does NOT settle (no decline)
 *   2. a client attaching mid-wait  → the re-send reaches it, its answer wins
 *   3. turn cancel while held       → the wait escapes as interrupted
 *   4. zero clients + push inactive → today's behaviour: immediate decline
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ active: false }));
vi.mock("../src/push/config.js", async (orig) => {
  const actual = await orig<typeof import("../src/push/config.js")>();
  return {
    ...actual,
    pushActive: () => h.active,
    pushConfig: () =>
      h.active
        ? {
            corpId: "ww",
            agentId: 1,
            secret: "s",
            toUser: "@all",
            contentDetail: "full" as const,
          }
        : null,
  };
});

const { requestWithTimeout, resendPendingInteractions } =
  await import("../src/handlers/server-requests.js");
const { NoClientsError } = await import("../src/remote/broadcast.js");
const { ZcodeAcpServer } = await import("../src/server.js");
const { setPushSenderForTests } = await import("../src/push/push.js");

/** Silences the failure warns from deliberately-failed interactions. */
let warnSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  h.active = false;
  warnSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  setPushSenderForTests({ sendText: async () => {} });
});
afterEach(() => {
  warnSpy?.mockRestore();
  vi.useRealTimers();
});

const PERM_PARAMS = { sessionId: "s1", toolCall: { title: "Bash: build" }, options: [] };

describe("offline interaction hold (§6)", () => {
  it("1. zero clients + push ACTIVE → does not decline, stays pending", async () => {
    h.active = true;
    const server = new ZcodeAcpServer();
    const cx = server.clients.broadcast();
    const wait = requestWithTimeout(
      server,
      cx,
      "session/request_permission",
      PERM_PARAMS,
      "perm",
      0,
    );
    const outcome = await Promise.race([
      wait.then(() => "settled"),
      new Promise((r) => setTimeout(() => r("pending"), 200)),
    ]);
    expect(outcome).toBe("pending");
    // And the failing attempt was the typed no-clients error.
    await expect(cx.request("x/unknown")).rejects.toBeInstanceOf(NoClientsError);
  });

  it("2. a client that attaches later receives the re-send and its answer wins", async () => {
    vi.useFakeTimers();
    h.active = true;
    const server = new ZcodeAcpServer();
    const cx = server.clients.broadcast();
    const wait = requestWithTimeout(
      server,
      cx,
      "session/request_permission",
      PERM_PARAMS,
      "perm",
      0,
    );
    await vi.advanceTimersByTimeAsync(0); // let the held attempt reject + hold

    const asked: Array<{ method: string; params: unknown }> = [];
    const client = {
      notify: async () => {},
      request: async (method: string, params: unknown) => {
        asked.push({ method, params });
        return { outcome: "allow" };
      },
    };
    resendPendingInteractions(server, client, "s1");
    await vi.advanceTimersByTimeAsync(400); // past RESEND_DELAY_MS (300)

    expect(asked).toHaveLength(1);
    expect(asked[0]!.method).toBe("session/request_permission");
    await expect(wait).resolves.toEqual({ outcome: "allow" });
  });

  it("3. turn cancel while held → escapes as interrupted", async () => {
    vi.useFakeTimers();
    h.active = true;
    const server = new ZcodeAcpServer();
    const cx = server.clients.broadcast();
    const wait = requestWithTimeout(
      server,
      cx,
      "session/request_permission",
      PERM_PARAMS,
      "perm",
      0,
      {
        zcodeSid: "z1",
        cancelled: true,
      },
    );
    await vi.advanceTimersByTimeAsync(200); // past the 100ms cancel poll
    // INTERRUPTED is a module-private symbol; a symbol result IS the marker.
    expect(typeof (await wait)).toBe("symbol");
  });

  it("4. zero clients + push inactive → declines immediately (today's behaviour)", async () => {
    h.active = false;
    const server = new ZcodeAcpServer();
    const cx = server.clients.broadcast();
    const outcome = await Promise.race([
      requestWithTimeout(server, cx, "session/request_permission", PERM_PARAMS, "perm", 0).then(
        (v) => ({ settled: true, value: v }),
      ),
      new Promise((r) => setTimeout(() => r({ settled: false }), 200)),
    ]);
    expect(outcome).toEqual({ settled: true, value: null });
  });
});
