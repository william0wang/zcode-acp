/**
 * i18n resolution tests: ZCODE_ACP_LANG override → ZCode app settings
 * (~/.zcode/v2/setting.json, mocked fs) → POSIX locale sniff → English
 * default, plus table completeness (no empty entry in either language).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fake settings-file content; null = file absent (ENOENT).
let settingJson: string | null = null;

vi.mock("node:fs", () => ({
  readFileSync: (p: unknown) => {
    if (settingJson !== null && String(p).endsWith(".zcode/v2/setting.json")) {
      return settingJson;
    }
    throw new Error("ENOENT (fake)");
  },
}));

async function freshModule() {
  vi.resetModules();
  return import("../src/i18n.js");
}

beforeEach(() => {
  settingJson = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveLanguage", () => {
  it("defaults to English with nothing configured", async () => {
    const { resolveLanguage } = await freshModule();
    expect(resolveLanguage({})).toBe("en");
  });

  it("ZCODE_ACP_LANG wins over everything (prefix + case-insensitive)", async () => {
    const { resolveLanguage } = await freshModule();
    settingJson = JSON.stringify({ locale: "zh-CN" });
    expect(resolveLanguage({ ZCODE_ACP_LANG: "en" })).toBe("en");
    expect(resolveLanguage({ ZCODE_ACP_LANG: "ZH_CN.UTF-8", LANG: "en_US" })).toBe("zh");
  });

  it("inherits the app's localePreference, then locale", async () => {
    const { resolveLanguage } = await freshModule();
    settingJson = JSON.stringify({ localePreference: "zh-CN", locale: "en-US" });
    expect(resolveLanguage({})).toBe("zh");
    settingJson = JSON.stringify({ locale: "zh-CN" });
    expect(resolveLanguage({})).toBe("zh");
  });

  it("falls through a missing or malformed app settings file", async () => {
    const { resolveLanguage } = await freshModule();
    settingJson = "{not json";
    expect(resolveLanguage({ LANG: "zh_CN.UTF-8" })).toBe("zh");
    settingJson = null;
    expect(resolveLanguage({ LANG: "zh_CN.UTF-8" })).toBe("zh");
    expect(resolveLanguage({ LANG: "en_US.UTF-8" })).toBe("en");
  });

  it("sniffs LC_ALL before LC_MESSAGES before LANG", async () => {
    const { resolveLanguage } = await freshModule();
    expect(resolveLanguage({ LC_ALL: "en_US", LANG: "zh_CN" })).toBe("en");
    expect(resolveLanguage({ LC_MESSAGES: "zh_CN", LANG: "en_US" })).toBe("zh");
    expect(resolveLanguage({ LANG: "zh_CN.UTF-8" })).toBe("zh");
    expect(resolveLanguage({ LANG: "C" })).toBe("en");
  });
});

describe("message tables", () => {
  it("every entry is a non-empty string (functions called with dummy args)", async () => {
    const { messages } = await freshModule();
    vi.stubEnv("ZCODE_ACP_LANG", "zh");
    const zh = Object.values(messages());
    vi.stubEnv("ZCODE_ACP_LANG", "en");
    const en = Object.values(messages());
    for (const value of [...zh, ...en]) {
      const strings =
        typeof value === "function"
          ? [value(["x"], 1, 2, "err")]
          : typeof value === "object" && value !== null
            ? Object.values(value)
            : [value];
      expect(strings.length).toBeGreaterThan(0);
      for (const s of strings) {
        expect(typeof s).toBe("string");
        expect(s.length).toBeGreaterThan(0);
      }
    }
    expect(zh.length).toBe(en.length);
  });

  it("messages() follows env changes per call", async () => {
    const { messages } = await freshModule();
    vi.stubEnv("ZCODE_ACP_LANG", "zh");
    expect(messages().sandboxOptionAllowAlways).toBe("始终允许");
    vi.stubEnv("ZCODE_ACP_LANG", "en");
    expect(messages().sandboxOptionAllowAlways).toBe("Always allow");
  });
});
