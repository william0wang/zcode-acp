/**
 * enc:v2:os credential store + interaction/requestCredentialCipher.
 *
 * The desktop 3.18.0 migration rewrote every ~/.zcode/v2/credentials.json
 * value to `enc:v2:os:<fp24>:<iv>.<tag>.<data>` keyed by an OS-keyring entry
 * (observed live 2026-11-12: the pre-v2 reader passed the ciphertext through
 * as "plaintext" and every bridge turn failed with model_request_failed).
 * These tests pin the wire format against the upstream algorithm
 * (systemCredentialCipher.ts) and the requestId-correlated reply shape the
 * CLI's strict zod schema demands.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { credentialCipherOp } = vi.hoisted(() => ({ credentialCipherOp: vi.fn() }));
vi.mock("../src/backend/credential-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/backend/credential-store.js")>();
  return { ...actual, credentialCipherOp };
});

vi.mock("../src/handlers/io.js", () => ({
  sendSessionUpdate: vi.fn().mockResolvedValue(undefined),
}));

import type { ServerRequest, ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeAcpServer } from "../src/server.js";
import {
  readCredentialStoreSync,
  resolveCredentialSecret,
  decryptV2Os,
  encryptV2Os,
} from "../src/backend/credential-store.js";
import { handleServerRequests } from "../src/handlers/server-requests.js";

const KEY = randomBytes(32);

/** Upstream's own seal(), re-implemented from systemCredentialCipher.ts. */
function upstreamSeal(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), bytes].map((p) => p.toString("base64url")).join(".");
}

function upstreamOpen(payload: string, key: Buffer): string {
  const [iv, tag, bytes] = payload.split(".").map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(bytes), decipher.final()]).toString("utf8");
}

function fingerprintOf(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

describe("enc:v2:os wire format (upstream parity)", () => {
  it("encrypts to enc:v2:os:<fp24>:<iv>.<tag>.<data> — no doubled os segment", () => {
    const value = encryptV2Os("plain-secret", KEY);
    expect(value.startsWith("enc:v2:os:")).toBe(true);
    const [fp, sealed] = value.slice("enc:v2:os:".length).split(":");
    expect(fp).toMatch(/^[a-f0-9]{24}$/);
    expect(fp).toBe(fingerprintOf(KEY));
    expect(sealed.split(".")).toHaveLength(3);
  });

  it("round-trips through our own decrypt", () => {
    expect(decryptV2Os(encryptV2Os("plain-secret", KEY), KEY)).toBe("plain-secret");
  });

  it("decrypts a value sealed by upstream's own algorithm", () => {
    const value = `enc:v2:os:${fingerprintOf(KEY)}:${upstreamSeal("cross-check", KEY)}`;
    expect(decryptV2Os(value, KEY)).toBe("cross-check");
  });

  it("is readable by upstream's algorithm when encrypted by us", () => {
    const value = encryptV2Os("cross-check-2", KEY);
    const sealed = value.slice("enc:v2:os:".length).split(":")[1]!;
    expect(upstreamOpen(sealed, KEY)).toBe("cross-check-2");
  });

  it("rejects a key whose fingerprint does not match", () => {
    const other = randomBytes(32);
    const value = `enc:v2:os:${fingerprintOf(other)}:${upstreamSeal("x", other)}`;
    expect(() => decryptV2Os(value, KEY)).toThrow("credential_decrypt_key_mismatch");
  });

  it("rejects malformed payloads", () => {
    expect(() => decryptV2Os("enc:v2:os:nocolon", KEY)).toThrow("credential_decrypt_malformed");
    expect(() => decryptV2Os("enc:v2:os:aabbcc.a.b", KEY)).toThrow();
  });
});

describe("readCredentialStoreSync (hermetic HOME: no keyring key)", () => {
  function writeStore(entries: Record<string, string>): void {
    const file = path.join(homedir(), ".zcode", "v2", "credentials.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(entries), "utf8");
  }

  it("keeps plaintext, skips every enc: value it cannot open (never ciphertext-as-plaintext)", () => {
    const wrongKey = createHash("sha256").update("not-the-fallback").digest();
    writeStore({
      plain: "plain-value",
      wrongSecretV1: `enc:v1:${upstreamSeal("x", wrongKey)}`,
      migrated: `enc:v2:os:${"a".repeat(24)}:${upstreamSeal("x", KEY)}`,
      envSourced: `enc:v2:env:${"b".repeat(24)}:${upstreamSeal("y", KEY)}`,
    });
    const store = readCredentialStoreSync();
    expect(store["plain"]).toBe("plain-value");
    expect(store["wrongSecretV1"]).toBeUndefined();
    expect(store["migrated"]).toBeUndefined();
    expect(store["envSourced"]).toBeUndefined();
  });

  it("decrypts v1 entries sealed with the fallback-secret derivation", () => {
    const key = createHash("sha256").update(resolveCredentialSecret()).digest();
    writeStore({ legacy: `enc:v1:${upstreamSeal("fallback-secret", key)}` });
    expect(readCredentialStoreSync()["legacy"]).toBe("fallback-secret");
  });
});

describe("interaction/requestCredentialCipher reply shape", () => {
  function makeServer(): ZcodeAcpServer {
    return { nextId: () => 1, resolveSid: () => undefined } as unknown as ZcodeAcpServer;
  }

  function makeBackend(queue: ServerRequest[]) {
    return {
      pollServerRequests: () => queue.splice(0, queue.length),
      requeueServerRequests: (reqs: ServerRequest[]) => queue.unshift(...reqs),
      sendReply: vi.fn(),
      sendError: vi.fn(),
    } as unknown as ZcodeBackend;
  }

  function cipherRequest(zcodeId: number, params: Record<string, unknown>): ServerRequest {
    return { id: zcodeId, method: "interaction/requestCredentialCipher", params };
  }

  const cx = { request: vi.fn() } as never;

  beforeEach(() => {
    credentialCipherOp.mockReset();
  });

  it("replies {requestId, result:{ok:true, value}} — the CLI's strict zod shape", async () => {
    credentialCipherOp.mockReturnValue("decrypted-value");
    const backend = makeBackend([
      cipherRequest(501, { requestId: "6f2a-req", operation: "decrypt", value: "enc:v2:os:x" }),
    ]);
    await handleServerRequests(makeServer(), backend, cx, "s1");
    expect(backend.sendReply).toHaveBeenCalledWith(501, {
      requestId: "6f2a-req",
      result: { ok: true, value: "decrypted-value" },
    });
    expect(backend.sendError).not.toHaveBeenCalled();
  });

  it("declines via result:{ok:false} (RPC success), never an uncorrelated error", async () => {
    credentialCipherOp.mockReturnValue(null);
    const backend = makeBackend([
      cipherRequest(502, { requestId: "6f2b-req", operation: "encrypt", value: "tok" }),
    ]);
    await handleServerRequests(makeServer(), backend, cx, "s1");
    const [id, result] = vi.mocked(backend.sendReply).mock.calls[0]!;
    expect(id).toBe(502);
    expect(result).toEqual({
      requestId: "6f2b-req",
      result: {
        ok: false,
        error: {
          code: "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE",
          message: expect.any(String),
        },
      },
    });
    expect(backend.sendError).not.toHaveBeenCalled();
  });

  it("protocol-errors an ask without requestId (no way to correlate)", async () => {
    credentialCipherOp.mockReturnValue("x");
    const backend = makeBackend([
      cipherRequest(503, { operation: "decrypt", value: "enc:v2:os:x" }),
    ]);
    await handleServerRequests(makeServer(), backend, cx, "s1");
    expect(backend.sendReply).not.toHaveBeenCalled();
    expect(backend.sendError).toHaveBeenCalledWith(503, -32601, expect.stringContaining("requestId"));
  });
});
