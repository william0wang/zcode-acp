/**
 * ZCode 官方插件 MCP（`auth: { type: "zcode_official", provider: "jwt_token" }`）
 * 的鉴权头构造与可信 Origin 校验。
 *
 * 与 ZCode 桌面端 `officialMcpCredentials.ts` 保持协议对齐：
 * - 校验 `targetOrigin` 必须匹配当前权威的 ZCode API Origin（避免向不可信域名泄漏凭证）；
 * - 从本机加密凭据库读取 `zcodejwttoken`（填入 `Authorization: Bearer ...`）与当前启用
 *   Coding Plan 家族的 MaaS 登录 JWT `oauth:<family>:access_token`（填入
 *   `X-Bigmodel-Authorization: Bearer ...` 及 `Bigmodel-Target-Type: PERSONAL`）；
 * - 严禁在日志中打印任何 Token 原文。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { readCredentialStoreSync } from "../backend/credential-store.js";
import { ZCODE_CREDS_PATH } from "../utils.js";
import { isCodingPlanFamily, type CodingPlanFamily } from "./project-token.js";

/** ZCode 生产环境默认服务源，供插件 `${ZCODE_BASE_URL}` 展开与可信 Origin 校验使用。 */
export const DEFAULT_ZCODE_BASE_URL = "https://zcode.z.ai";

/** 官方 MCP 鉴权头名称（与 ZCode `OFFICIAL_MCP_AUTH_HEADER_NAMES` 对齐）。 */
export const OFFICIAL_MCP_AUTH_HEADER_NAMES = {
  authorization: "Authorization",
  codingPlanAuthorization: "X-Bigmodel-Authorization",
  targetType: "Bigmodel-Target-Type",
} as const;

/** 官方 MCP 鉴权失败原因枚举（与 `zcode.cjs` 的 `interaction/requestOfficialMcpAuthHeaders` 返回 schema 对齐）。 */
export type OfficialMcpAuthFailureReason =
  "official_auth_unavailable" | "official_auth_plan_required" | "official_mcp_origin_untrusted";

/** `interaction/requestOfficialMcpAuthHeaders` 的标准返回结构。 */
export type OfficialMcpAuthHeadersOutcome =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

const ZCODE_JWT_CREDENTIAL_KEY = "zcodejwttoken";
const OAUTH_ACTIVE_PROVIDER_KEY = "oauth:active_provider";
const DEV_TRUSTED_ORIGINS_ENV = "ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS";

interface DesktopSettingSnapshot {
  modelProviderFamilyModes?: Record<string, unknown>;
  providerFamilyConnectionSelections?: Record<string, { kind?: unknown } | null>;
  providerFamilyDomain?: unknown;
}

/** 去除字符串首尾空白与可选的 `Bearer ` 前缀，返回裸 Token。 */
function stripBearerPrefix(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const bare = trimmed.replace(/^Bearer\s+/iu, "").trim();
  return bare || null;
}

/** 规范化 HTTPS Origin；非法 URL 或非 https 协议返回 null。 */
function normalizeHttpsOrigin(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** 规范化本地开发回环 HTTP Origin（仅 localhost / 127.0.0.1 / [::1]）。 */
function normalizeLoopbackOrigin(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    const isLoopback =
      url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    if (url.protocol !== "http:" || !isLoopback) return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * 解析注入给 `zcode app-server` 的权威 ZCode 服务源（用于 `ZCODE_BASE_URL`）。
 *
 * 刻意不读取进程继承的 `ZCODE_BASE_URL`（该变量可能被外部环境误设为模型推理 API 地址），
 * 仅接受显式 `ZCODE_ENDPOINT_ORIGIN` 或默认生产域名 `https://zcode.z.ai`。
 */
export function resolveOfficialZCodeBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ZCODE_ENDPOINT_ORIGIN?.trim();
  if (explicit) {
    const normalized = normalizeHttpsOrigin(explicit) ?? normalizeLoopbackOrigin(explicit);
    if (normalized) return normalized;
  }
  return DEFAULT_ZCODE_BASE_URL;
}

/**
 * 校验官方 MCP 请求的 `targetOrigin` 是否可信，防止凭证被发送到非 ZCode 域名。
 */
export function isTrustedOfficialMcpOrigin(
  targetOrigin: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const trimmed = targetOrigin?.trim();
  if (!trimmed) return false;

  // 允许通过 ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS 显式信任本地回环调试地址
  const loopbackTarget = normalizeLoopbackOrigin(trimmed);
  if (loopbackTarget) {
    const devRaw = env[DEV_TRUSTED_ORIGINS_ENV]?.trim();
    if (devRaw) {
      for (const candidate of devRaw.split(",")) {
        if (normalizeLoopbackOrigin(candidate) === loopbackTarget) {
          return true;
        }
      }
    }
  }

  const expectedBase = resolveOfficialZCodeBaseUrl(env);
  const expectedHttps = normalizeHttpsOrigin(expectedBase);
  const targetHttps = normalizeHttpsOrigin(trimmed);
  if (expectedHttps && targetHttps) {
    return targetHttps === expectedHttps;
  }

  const expectedLoopback = normalizeLoopbackOrigin(expectedBase);
  if (expectedLoopback && loopbackTarget) {
    return loopbackTarget === expectedLoopback;
  }

  return false;
}

/** 读取桌面端 `setting.json` 中的连接选择与当前家族（失败时静默返回 null）。 */
function readDesktopSetting(credsDir: string): DesktopSettingSnapshot | null {
  try {
    return JSON.parse(
      readFileSync(path.join(credsDir, "setting.json"), "utf8"),
    ) as DesktopSettingSnapshot;
  } catch {
    return null;
  }
}

/** 从凭据库中读取指定家族的 MaaS OAuth 登录 Token（裸值）。 */
function readFamilyOAuthToken(
  store: Record<string, string>,
  family: CodingPlanFamily,
): string | null {
  return stripBearerPrefix(store[`oauth:${family}:access_token`]);
}

/**
 * 解析当前生效的个人 Coding Plan 家族及其 MaaS JWT。
 *
 * 优先级：
 * 1. `setting.json` 中显式选中的 `individual-coding-plan`（且非 `apiKey` 模式）并持有 OAuth Token；
 * 2. 若 `setting.json` 缺失，则回退到凭据库中的 `oauth:active_provider` 或任一已登录的个人家族。
 */
function resolveActiveCodingPlanToken(
  store: Record<string, string>,
  credsDir: string,
): { family: CodingPlanFamily; token: string } | null {
  const setting = readDesktopSetting(credsDir);
  const preferredRaw =
    (typeof setting?.providerFamilyDomain === "string"
      ? setting.providerFamilyDomain.trim()
      : undefined) || store[OAUTH_ACTIVE_PROVIDER_KEY]?.trim();
  const preferredFamily =
    preferredRaw && isCodingPlanFamily(preferredRaw) ? preferredRaw : undefined;

  if (setting?.providerFamilyConnectionSelections) {
    const candidates: Array<{ family: CodingPlanFamily; token: string }> = [];
    for (const [family, selection] of Object.entries(setting.providerFamilyConnectionSelections)) {
      if (selection?.kind !== "individual-coding-plan") continue;
      if (setting.modelProviderFamilyModes?.[family] === "apiKey") continue;
      if (!isCodingPlanFamily(family)) continue;
      const token = readFamilyOAuthToken(store, family);
      if (token) candidates.push({ family, token });
    }
    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length > 1 && preferredFamily) {
      const hit = candidates.find((c) => c.family === preferredFamily);
      if (hit) return hit;
    }
    if (candidates.length > 0) return candidates[0]!;
    // setting.json 存在但未选中任何个人 Coding Plan，不盲目注入其他家族的 MaaS JWT
    return null;
  }

  // 无 setting.json 时的回退逻辑（纯 CLI / 无头环境）
  const order: CodingPlanFamily[] = preferredFamily
    ? [
        preferredFamily,
        ...(preferredFamily === "bigmodel" ? (["zai"] as const) : (["bigmodel"] as const)),
      ]
    : ["bigmodel", "zai"];
  for (const family of order) {
    const token = readFamilyOAuthToken(store, family);
    if (token) return { family, token };
  }
  return null;
}

/**
 * 响应 `interaction/requestOfficialMcpAuthHeaders` 请求，构造本次官方 MCP 调用所需的身份头。
 */
export function resolveOfficialMcpAuthHeaders(
  params: Record<string, unknown>,
  options?: {
    env?: NodeJS.ProcessEnv;
    credsDir?: string;
    credentialStore?: Record<string, string>;
  },
): OfficialMcpAuthHeadersOutcome {
  const env = options?.env ?? process.env;
  const targetOrigin = typeof params.targetOrigin === "string" ? params.targetOrigin : undefined;
  if (!isTrustedOfficialMcpOrigin(targetOrigin, env)) {
    return { ok: false, reason: "official_mcp_origin_untrusted" };
  }

  const store = options?.credentialStore ?? readCredentialStoreSync();
  const jwt = stripBearerPrefix(store[ZCODE_JWT_CREDENTIAL_KEY]);
  if (!jwt) {
    return { ok: false, reason: "official_auth_unavailable" };
  }

  const headers: Record<string, string> = {
    [OFFICIAL_MCP_AUTH_HEADER_NAMES.authorization]: `Bearer ${jwt}`,
  };

  const credsDir = options?.credsDir ?? path.dirname(ZCODE_CREDS_PATH);
  const codingPlan = resolveActiveCodingPlanToken(store, credsDir);
  if (codingPlan) {
    headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.codingPlanAuthorization] = `Bearer ${codingPlan.token}`;
    headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.targetType] = "PERSONAL";
  }

  return { ok: true, headers };
}
