/**
 * WeCom HTTP client (push-backend-requirements §9): token caching with the
 * expiry margin, the one-shot 40014/42001 refresh+retry, final failures, and
 * the 2048-byte content cap. All against a scripted fake fetch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWeComSender, truncateUtf8, type WeComFetch } from "../src/push/wecom.js";

interface Call {
  url: string;
  body?: string;
}

function makeFetch() {
  const calls: Call[] = [];
  let tokenCount = 0;
  // Each queue entry: how this call should answer.
  const sendAnswers: Array<{ errcode: number; errmsg?: string }> = [];
  let tokenAnswer: { errcode: number; access_token?: string; expires_in?: number } = {
    errcode: 0,
    access_token: "tok-1",
    expires_in: 7200,
  };
  const impl: WeComFetch = async (url, init) => {
    calls.push({ url, body: init?.body });
    let payload: Record<string, unknown>;
    if (url.startsWith("https://qyapi.weixin.qq.com/cgi-bin/gettoken")) {
      tokenCount++;
      payload = { errmsg: "ok", ...tokenAnswer };
    } else {
      const answer = sendAnswers.length > 1 ? sendAnswers.shift() : sendAnswers[0]!;
      payload = { errmsg: "ok", ...answer };
    }
    return {
      ok: true,
      status: 200,
      json: async () => payload,
    };
  };
  return {
    calls,
    impl,
    nextToken: (t: string) => {
      tokenAnswer = { errcode: 0, access_token: t, expires_in: 7200 };
    },
    queueSend: (...answers: Array<{ errcode: number; errmsg?: string }>) => {
      sendAnswers.push(...answers);
    },
    tokenCount: () => tokenCount,
  };
}

const CFG = { corpId: "ww-corp", agentId: 1000002, secret: "s3cret", toUser: "@all" };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createWeComSender", () => {
  it("fetches a token, sends the contracted text body, then reuses the token", async () => {
    const f = makeFetch();
    f.queueSend({ errcode: 0 });
    const sender = createWeComSender(CFG, f.impl);
    await sender.sendText("[test] Hello");
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]!.url).toContain("corpid=ww-corp");
    expect(f.calls[0]!.url).toContain("corpsecret=s3cret");
    expect(JSON.parse(f.calls[1]!.body!)).toEqual({
      touser: "@all",
      msgtype: "text",
      agentid: 1000002,
      text: { content: "[test] Hello" },
    });

    await sender.sendText("again");
    expect(f.calls).toHaveLength(3); // no second gettoken
    expect(f.tokenCount()).toBe(1);
    expect(JSON.parse(f.calls[2]!.body!).text.content).toBe("again");
  });

  it("refreshes the token once and retries on 40014/42001", async () => {
    for (const code of [40014, 42001]) {
      const f = makeFetch();
      f.queueSend({ errcode: code, errmsg: "invalid token" }, { errcode: 0 });
      f.nextToken(`tok-${code}`);
      const sender = createWeComSender(CFG, f.impl);
      await sender.sendText("retry me");
      expect(f.calls).toHaveLength(4); // gettoken, send(fail), gettoken, send(ok)
      expect(f.tokenCount()).toBe(2);
      expect(f.calls[3]!.url).toContain("tok-");
      expect(JSON.parse(f.calls[3]!.body!).text.content).toBe("retry me");
    }
  });

  it("fails finally when the retry still answers an invalid-token code", async () => {
    const f = makeFetch();
    f.queueSend({ errcode: 40014 }, { errcode: 40014 });
    const sender = createWeComSender(CFG, f.impl);
    await expect(sender.sendText("nope")).rejects.toThrow("wecom message/send failed: 40014");
    expect(f.calls).toHaveLength(4); // exactly one refresh — no third attempt
  });

  it("fails without refresh on other error codes", async () => {
    const f = makeFetch();
    f.queueSend({ errcode: 60020, errmsg: "not allowed" });
    const sender = createWeComSender(CFG, f.impl);
    await expect(sender.sendText("x")).rejects.toThrow("60020");
    expect(f.calls).toHaveLength(2);
  });

  it("propagates a failed gettoken", async () => {
    const failing: WeComFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ errcode: 40001, errmsg: "bad secret" }),
    });
    const sender = createWeComSender(CFG, failing);
    await expect(sender.sendText("x")).rejects.toThrow("wecom gettoken failed: 40001");
  });

  it("re-fetches the token once the expiry margin passes", async () => {
    const f = makeFetch();
    f.queueSend({ errcode: 0 });
    const sender = createWeComSender(CFG, f.impl);
    await sender.sendText("first");
    // Cached expiry = 7200s minus the 5-minute margin → past 6900s it re-fetches.
    vi.advanceTimersByTime(6_901_000);
    f.queueSend({ errcode: 0 });
    f.nextToken("tok-2");
    await sender.sendText("second");
    expect(f.tokenCount()).toBe(2);
  });

  it("truncates oversized content at the byte cap without splitting UTF-8", async () => {
    const f = makeFetch();
    f.queueSend({ errcode: 0 });
    const sender = createWeComSender(CFG, f.impl);
    const long = `[test] ${"é".repeat(3000)}`; // 2 bytes per char — far over 2048
    await sender.sendText(long);
    const sent = JSON.parse(f.calls[1]!.body!).text.content as string;
    expect(Buffer.byteLength(sent, "utf8")).toBeLessThanOrEqual(2048);
    expect(sent.endsWith("…")).toBe(true);
  });
});

describe("truncateUtf8", () => {
  it("passes short strings through untouched", () => {
    expect(truncateUtf8("hello", 100)).toBe("hello");
  });

  it("never splits a multi-byte sequence", () => {
    const out = truncateUtf8("中".repeat(100), 10); // 3 bytes each
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(10);
    // The first byte of a UTF-8 continuation never leads the kept part.
    expect(out.charCodeAt(0)).toBeGreaterThan(255); // still a full char start
    expect(out.endsWith("…")).toBe(true);
  });
});
