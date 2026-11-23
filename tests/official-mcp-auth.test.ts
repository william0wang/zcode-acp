import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import {
  DEFAULT_ZCODE_BASE_URL,
  isTrustedOfficialMcpOrigin,
  resolveOfficialMcpAuthHeaders,
  resolveOfficialZCodeBaseUrl,
} from "../src/config/official-mcp-auth.js";
import { answerOfficialMcpAuthHeaders } from "../src/handlers/server-requests.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "zcode-official-mcp-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("resolveOfficialZCodeBaseUrl", () => {
  it("returns the production origin by default and ignores an inherited ZCODE_BASE_URL", () => {
    expect(
      resolveOfficialZCodeBaseUrl({ ZCODE_BASE_URL: "https://open.bigmodel.cn/api/anthropic" }),
    ).toBe(DEFAULT_ZCODE_BASE_URL);
  });

  it("prefers and normalizes an explicit valid ZCODE_ENDPOINT_ORIGIN", () => {
    expect(
      resolveOfficialZCodeBaseUrl({ ZCODE_ENDPOINT_ORIGIN: "https://zcode.example.com/v1/" }),
    ).toBe("https://zcode.example.com");
  });
});

describe("isTrustedOfficialMcpOrigin", () => {
  it("trusts only the matching official origin; rejects third-party domains and empty values", () => {
    expect(isTrustedOfficialMcpOrigin("https://zcode.z.ai", {})).toBe(true);
    expect(
      isTrustedOfficialMcpOrigin("https://zcode.z.ai/api/v1/mcp/server/finance_tianyancha", {}),
    ).toBe(true);
    expect(isTrustedOfficialMcpOrigin("https://evil.example.com", {})).toBe(false);
    expect(isTrustedOfficialMcpOrigin("", {})).toBe(false);
    expect(isTrustedOfficialMcpOrigin(undefined, {})).toBe(false);
  });

  it("allows trusting loopback debug origins via ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS", () => {
    expect(
      isTrustedOfficialMcpOrigin("http://127.0.0.1:8787", {
        ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS: "http://127.0.0.1:8787",
      }),
    ).toBe(true);
    expect(isTrustedOfficialMcpOrigin("http://127.0.0.1:8787", {})).toBe(false);
  });
});

describe("resolveOfficialMcpAuthHeaders", () => {
  it("returns the full identity header set for a logged-in personal Coding Plan and normalizes Bearer prefixes", () => {
    const dir = makeTempDir();
    writeFileSync(
      path.join(dir, "setting.json"),
      JSON.stringify({
        providerFamilyDomain: "bigmodel",
        providerFamilyConnectionSelections: {
          bigmodel: { kind: "individual-coding-plan" },
        },
      }),
    );

    const outcome = resolveOfficialMcpAuthHeaders(
      { targetOrigin: "https://zcode.z.ai", pluginId: "tianyancha", mcpKey: "tianyancha" },
      {
        env: {},
        credsDir: dir,
        credentialStore: {
          zcodejwttoken: "Bearer zcode-jwt-123",
          "oauth:bigmodel:access_token": "maas-jwt-456",
        },
      },
    );

    expect(outcome).toEqual({
      ok: true,
      headers: {
        Authorization: "Bearer zcode-jwt-123",
        "X-Bigmodel-Authorization": "Bearer maas-jwt-456",
        "Bigmodel-Target-Type": "PERSONAL",
      },
    });
  });

  it("emits the atomic TEAM scope pair for a bigmodel team-coding-plan selection", () => {
    const dir = makeTempDir();
    writeFileSync(
      path.join(dir, "setting.json"),
      JSON.stringify({
        providerFamilyDomain: "bigmodel",
        providerFamilyConnectionSelections: {
          bigmodel: {
            kind: "team-coding-plan",
            productId: "team-product",
            organizationId: "org-42",
            projectId: "proj-7",
          },
        },
      }),
    );

    const outcome = resolveOfficialMcpAuthHeaders(
      { targetOrigin: "https://zcode.z.ai" },
      {
        env: {},
        credsDir: dir,
        credentialStore: {
          zcodejwttoken: "zcode-jwt-team",
          "oauth:bigmodel:access_token": "maas-jwt-team",
        },
      },
    );

    expect(outcome).toEqual({
      ok: true,
      headers: {
        Authorization: "Bearer zcode-jwt-team",
        "X-Bigmodel-Authorization": "Bearer maas-jwt-team",
        "Bigmodel-Target-Type": "TEAM",
        "Bigmodel-Organization": "org-42",
        "Bigmodel-Project": "proj-7",
      },
    });
  });

  it("sends the plan token without scope headers for a zai team selection", () => {
    const dir = makeTempDir();
    writeFileSync(
      path.join(dir, "setting.json"),
      JSON.stringify({
        providerFamilyDomain: "zai",
        providerFamilyConnectionSelections: {
          zai: {
            kind: "team-coding-plan",
            productId: "team-product",
            organizationId: "org-42",
            projectId: "proj-7",
          },
        },
      }),
    );

    const outcome = resolveOfficialMcpAuthHeaders(
      { targetOrigin: "https://zcode.z.ai" },
      {
        env: {},
        credsDir: dir,
        credentialStore: {
          zcodejwttoken: "zcode-jwt-zai",
          "oauth:zai:access_token": "maas-jwt-zai",
        },
      },
    );

    expect(outcome).toEqual({
      ok: true,
      headers: {
        Authorization: "Bearer zcode-jwt-zai",
        "X-Bigmodel-Authorization": "Bearer maas-jwt-zai",
      },
    });
  });

  it("falls back to identity-only when a bigmodel team selection lacks the org/project pair", () => {
    const dir = makeTempDir();
    writeFileSync(
      path.join(dir, "setting.json"),
      JSON.stringify({
        providerFamilyDomain: "bigmodel",
        providerFamilyConnectionSelections: {
          bigmodel: { kind: "team-coding-plan", productId: "team-product", organizationId: "org" },
        },
      }),
    );

    const outcome = resolveOfficialMcpAuthHeaders(
      { targetOrigin: "https://zcode.z.ai" },
      {
        env: {},
        credsDir: dir,
        credentialStore: {
          zcodejwttoken: "zcode-jwt-broken",
          "oauth:bigmodel:access_token": "maas-jwt-broken",
        },
      },
    );

    expect(outcome).toEqual({
      ok: true,
      headers: {
        Authorization: "Bearer zcode-jwt-broken",
      },
    });
  });

  it("sends only the ZCode JWT when logged in without a coding-plan selection", () => {
    const dir = makeTempDir();
    writeFileSync(
      path.join(dir, "setting.json"),
      JSON.stringify({
        providerFamilyConnectionSelections: {
          bigmodel: { kind: "start-plan" },
        },
      }),
    );

    const outcome = resolveOfficialMcpAuthHeaders(
      { targetOrigin: "https://zcode.z.ai" },
      {
        env: {},
        credsDir: dir,
        credentialStore: {
          zcodejwttoken: "zcode-jwt-only",
          "oauth:bigmodel:access_token": "maas-jwt-unused",
        },
      },
    );

    expect(outcome).toEqual({
      ok: true,
      headers: {
        Authorization: "Bearer zcode-jwt-only",
      },
    });
  });

  it("returns official_auth_unavailable when zcodejwttoken is missing", () => {
    const outcome = resolveOfficialMcpAuthHeaders(
      { targetOrigin: "https://zcode.z.ai" },
      { env: {}, credsDir: makeTempDir(), credentialStore: {} },
    );
    expect(outcome).toEqual({ ok: false, reason: "official_auth_unavailable" });
  });

  it("rejects an untrusted targetOrigin with official_mcp_origin_untrusted", () => {
    const outcome = resolveOfficialMcpAuthHeaders(
      { targetOrigin: "https://attacker.example" },
      {
        env: {},
        credsDir: makeTempDir(),
        credentialStore: { zcodejwttoken: "should-never-leak" },
      },
    );
    expect(outcome).toEqual({ ok: false, reason: "official_mcp_origin_untrusted" });
  });
});

describe("answerOfficialMcpAuthHeaders", () => {
  it("returns false for a non-official-auth request without replying", () => {
    const sendReply = vi.fn();
    const backend = { sendReply } as unknown as ZcodeBackend;
    expect(answerOfficialMcpAuthHeaders(backend, 1, "interaction/requestPermission", {})).toBe(
      false,
    );
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("answers official_mcp_origin_untrusted for an untrusted-origin request", () => {
    const sendReply = vi.fn();
    const backend = { sendReply } as unknown as ZcodeBackend;
    expect(
      answerOfficialMcpAuthHeaders(
        backend,
        "server-1",
        "interaction/requestOfficialMcpAuthHeaders",
        {
          pluginId: "tianyancha",
          mcpKey: "tianyancha",
          targetOrigin: "https://untrusted.example",
        },
      ),
    ).toBe(true);
    expect(sendReply).toHaveBeenCalledWith("server-1", {
      ok: false,
      reason: "official_mcp_origin_untrusted",
    });
  });
});
