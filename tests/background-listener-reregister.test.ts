/**
 * ensureBackgroundListener re-registration across backend respawns.
 *
 * Listeners are registered per ZcodeBackend INSTANCE. A mid-session respawn
 * (sandbox arm-flip, dynamic allow batches, dead-reader recovery) replaces
 * the instance — the cached listener must re-register on the new backend or
 * out-of-band consumption (background tasks, backend titles) silently dies.
 * The prompt path calls ensureBackgroundListener every turn so the heal
 * happens on the next prompt, not only on resume/load.
 */

import { describe, expect, it } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import { ZcodeAcpServer } from "../src/server.js";

function fakeBackend(): ZcodeBackend & { registered: string[] } {
  const registered: string[] = [];
  return {
    registered,
    isDead: false,
    request: async () => ({ result: {} }),
    send: () => {},
    pollServerRequests: () => [],
    registerEventListener(sid: string, listener: unknown) {
      registered.push(sid);
      void listener;
    },
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend & { registered: string[] };
}

/** Both out-of-band listeners register under the session id. */
const BOTH = ["zs_1", "zs_1"];

describe("ensureBackgroundListener across backend respawns", () => {
  it("returns the cached listener on the SAME backend instance", async () => {
    const server = new ZcodeAcpServer();
    const backend = fakeBackend();
    server.backend = backend;
    const a = await server.ensureBackgroundListener("zs_1");
    const b = await server.ensureBackgroundListener("zs_1");
    expect(a).toBe(b);
    // One BackgroundTaskListener + one SessionTitleListener, registered once.
    expect(backend.registered).toEqual(BOTH);
  });

  it("re-registers (both listeners) after the backend instance is replaced", async () => {
    const server = new ZcodeAcpServer();
    const first = fakeBackend();
    server.backend = first;
    const a = await server.ensureBackgroundListener("zs_1");
    expect(first.registered).toEqual(BOTH);

    // Respawn: a brand-new instance takes over.
    const second = fakeBackend();
    server.backend = second;
    const b = await server.ensureBackgroundListener("zs_1");
    // Same listener object (its per-task state survives), fresh registration
    // of BOTH listeners on the new instance — and no duplicate on a third call.
    expect(b).toBe(a);
    expect(second.registered).toEqual(BOTH);
    const c = await server.ensureBackgroundListener("zs_1");
    expect(c).toBe(a);
    expect(second.registered).toEqual(BOTH);
  });
});
