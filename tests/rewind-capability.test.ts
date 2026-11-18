/**
 * `_meta.zcode.rewind` capability flag: initialize advertises the rewind
 * extensions iff the desktop bundle meets the source-verified floor. The
 * bundle read is mocked — the real one depends on the host machine's
 * /Applications state, which a unit test must not.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const bundle = vi.hoisted(() => ({ atFloor: false }));

vi.mock("../src/config/deferred-probe-capability.js", () => ({
  desktopBundleAtLeast: (min: string) => min === "3.14.3" && bundle.atFloor,
}));

import { ZcodeAcpServer } from "../src/server.js";

async function advertisedRewind(): Promise<unknown> {
  const server = new ZcodeAcpServer();
  const res = await server.initialize({
    protocolVersion: 1,
    clientInfo: { name: "rewind-capability-test", version: "0" },
  } as never);
  const caps = res.agentCapabilities as { _meta?: { zcode?: { rewind?: unknown } } };
  return caps._meta?.zcode?.rewind;
}

beforeEach(() => {
  bundle.atFloor = false;
});

describe("_meta.zcode.rewind capability", () => {
  it("is advertised on a bundle at/above the floor", async () => {
    bundle.atFloor = true;
    await expect(advertisedRewind()).resolves.toBe(true);
  });

  it("is ABSENT (not false) on an older/unreadable bundle — the established unsupported spelling", async () => {
    await expect(advertisedRewind()).resolves.toBeUndefined();
  });
});
