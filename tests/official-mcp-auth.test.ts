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
  it("默认返回生产环境 ZCode 服务源，且忽略外部继承的 ZCODE_BASE_URL", () => {
    expect(
      resolveOfficialZCodeBaseUrl({ ZCODE_BASE_URL: "https://open.bigmodel.cn/api/anthropic" }),
    ).toBe(DEFAULT_ZCODE_BASE_URL);
  });

  it("显式配置合法 ZCODE_ENDPOINT_ORIGIN 时优先使用并规范化 origin", () => {
    expect(
      resolveOfficialZCodeBaseUrl({ ZCODE_ENDPOINT_ORIGIN: "https://zcode.example.com/v1/" }),
    ).toBe("https://zcode.example.com");
  });
});

describe("isTrustedOfficialMcpOrigin", () => {
  it("仅信任匹配的官方 origin，拒绝第三方域名与空值", () => {
    expect(isTrustedOfficialMcpOrigin("https://zcode.z.ai", {})).toBe(true);
    expect(
      isTrustedOfficialMcpOrigin("https://zcode.z.ai/api/v1/mcp/server/finance_tianyancha", {}),
    ).toBe(true);
    expect(isTrustedOfficialMcpOrigin("https://evil.example.com", {})).toBe(false);
    expect(isTrustedOfficialMcpOrigin("", {})).toBe(false);
    expect(isTrustedOfficialMcpOrigin(undefined, {})).toBe(false);
  });

  it("支持通过 ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS 信任本地回环调试地址", () => {
    expect(
      isTrustedOfficialMcpOrigin("http://127.0.0.1:8787", {
        ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS: "http://127.0.0.1:8787",
      }),
    ).toBe(true);
    expect(isTrustedOfficialMcpOrigin("http://127.0.0.1:8787", {})).toBe(false);
  });
});

describe("resolveOfficialMcpAuthHeaders", () => {
  it("完整登录态与个人 Coding Plan 下返回官方三元组身份头并规范化 Bearer 前缀", () => {
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

  it("已登录但未选中个人 Coding Plan 时仅携带 ZCode JWT", () => {
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

  it("缺少 zcodejwttoken 时返回 official_auth_unavailable", () => {
    const outcome = resolveOfficialMcpAuthHeaders(
      { targetOrigin: "https://zcode.z.ai" },
      { env: {}, credsDir: makeTempDir(), credentialStore: {} },
    );
    expect(outcome).toEqual({ ok: false, reason: "official_auth_unavailable" });
  });

  it("targetOrigin 不可信时直接拒绝并返回 official_mcp_origin_untrusted", () => {
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
  it("非官方 MCP 鉴权请求返回 false 且不发送回复", () => {
    const sendReply = vi.fn();
    const backend = { sendReply } as unknown as ZcodeBackend;
    expect(answerOfficialMcpAuthHeaders(backend, 1, "interaction/requestPermission", {})).toBe(
      false,
    );
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("对不可信 origin 请求应答 official_mcp_origin_untrusted", () => {
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
