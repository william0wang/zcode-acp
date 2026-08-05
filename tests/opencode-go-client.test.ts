/**
 * Header-shape test for the real Opencode Go HTTP client.
 *
 * Lives in its own file (no `vi.mock`) so `fetchGoDashboard` is the real
 * implementation and we can assert on the exact request headers passed to
 * global fetch. Other opencode-go tests mock the client module so they can
 * control the (text, finalUrl) pair deterministically.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchGoDashboard } from "../src/quota/opencode-go/client.js";

describe("fetchGoDashboard request headers", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");

  afterEach(() => {
    fetchSpy.mockReset();
  });

  it("sends Cookie: auth=<value> and a browser User-Agent", async () => {
    fetchSpy.mockResolvedValue(new Response("<html>ok</html>", { status: 200 }));

    await fetchGoDashboard("wrk_x", "Fe26.2**secret");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0]!;
    const url = call[0];
    const init = (call[1] ?? {}) as RequestInit;
    const headers = init.headers as Record<string, string>;

    expect(String(url)).toBe("https://opencode.ai/workspace/wrk_x/go");
    expect(init.method).toBe("GET");
    expect(headers.Cookie).toBe("auth=Fe26.2**secret");
    expect(headers["User-Agent"]).toMatch(/Firefox\//);
  });
});
