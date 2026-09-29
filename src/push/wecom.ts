/**
 * WeCom (企业微信) self-built-app push client — the whole outbound surface is
 * two HTTP endpoints (push-backend-requirements §9):
 *
 *   GET  /cgi-bin/gettoken?corpid=&corpsecret=  → {access_token, expires_in}
 *   POST /cgi-bin/message/send?access_token=    → {errcode: 0}
 *
 * Zero dependencies: platform `fetch`, injectable for tests. The access token
 * is cached with a 5-minute expiry margin; errcode 40014/42001 (invalid /
 * expired token) triggers ONE refresh + ONE send retry — a second failure is
 * final for that push. Callers are fire-and-forget and only warn.
 *
 * With `relay` configured both calls go through that base URL instead (with an
 * `x-relay-token` header) — a reverse proxy on a static-IP host, so WeCom's
 * 企业可信IP check (errcode 60020) only ever sees that host's egress IP.
 */

export interface WeComSender {
  sendText(content: string): Promise<void>;
}

/** Minimal fetch surface — the platform fetch satisfies it; tests fake it. */
export interface WeComFetch {
  (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
}

const API_BASE = "https://qyapi.weixin.qq.com";
/** Refresh before expiry so a send never rides a token about to die. */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** errcode 40014 = invalid token, 42001 = expired — both mean "refresh once". */
const INVALID_TOKEN_CODES = new Set([40014, 42001]);
/** WeCom text content cap — truncate from the end of the body. */
const MAX_CONTENT_BYTES = 2048;

export function createWeComSender(
  cfg: {
    corpId: string;
    agentId: number;
    secret: string;
    toUser: string;
    /** Route both API calls through a static-IP relay (see file header). */
    relay?: { url: string; token: string };
  },
  fetchImpl: WeComFetch = fetch as WeComFetch,
): WeComSender {
  const base = cfg.relay?.url ?? API_BASE;
  const relayHeaders = cfg.relay ? { "x-relay-token": cfg.relay.token } : undefined;
  let token: { value: string; expiresAt: number } | null = null;

  interface TokenResp {
    errcode?: number;
    errmsg?: string;
    access_token?: string;
    expires_in?: number;
  }
  interface SendResp {
    errcode?: number;
    errmsg?: string;
  }

  async function readJson(resp: { ok: boolean; status: number; json(): Promise<unknown> }) {
    try {
      return (await resp.json()) as TokenResp & SendResp;
    } catch {
      return { errcode: resp.status, errmsg: `HTTP ${resp.status} (non-JSON body)` };
    }
  }

  async function fetchToken(): Promise<string> {
    const url =
      `${base}/cgi-bin/gettoken?corpid=${encodeURIComponent(cfg.corpId)}` +
      `&corpsecret=${encodeURIComponent(cfg.secret)}`;
    const body = await readJson(await fetchImpl(url, { headers: relayHeaders }));
    if (body.errcode !== undefined && body.errcode !== 0) {
      throw new Error(`wecom gettoken failed: ${body.errcode} ${body.errmsg ?? ""}`.trim());
    }
    if (!body.access_token) throw new Error("wecom gettoken returned no access_token");
    const ttl = typeof body.expires_in === "number" ? body.expires_in * 1000 : 7200_000;
    token = {
      value: body.access_token,
      expiresAt: Date.now() + Math.max(ttl - TOKEN_MARGIN_MS, 60_000),
    };
    return body.access_token;
  }

  async function currentToken(force = false): Promise<string> {
    if (!force && token && Date.now() < token.expiresAt) return token.value;
    return fetchToken();
  }

  async function postSend(t: string, content: string): Promise<SendResp> {
    const resp = await fetchImpl(
      `${base}/cgi-bin/message/send?access_token=${encodeURIComponent(t)}`,
      {
        method: "POST",
        headers: relayHeaders,
        body: JSON.stringify({
          touser: cfg.toUser,
          msgtype: "text",
          agentid: cfg.agentId,
          text: { content },
        }),
      },
    );
    return readJson(resp);
  }

  async function sendText(content: string): Promise<void> {
    const bounded = truncateUtf8(content, MAX_CONTENT_BYTES);
    let resp = await postSend(await currentToken(), bounded);
    if (resp.errcode !== undefined && INVALID_TOKEN_CODES.has(resp.errcode)) {
      resp = await postSend(await currentToken(true), bounded);
    }
    if (resp.errcode !== undefined && resp.errcode !== 0) {
      throw new Error(`wecom message/send failed: ${resp.errcode} ${resp.errmsg ?? ""}`.trim());
    }
  }

  return { sendText };
}

/** Truncate to a byte cap without splitting a UTF-8 sequence. */
export function truncateUtf8(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  let chars = Math.floor(maxBytes / 4); // every char is at most 4 bytes
  while (chars > 0 && Buffer.byteLength(s.slice(0, chars), "utf8") > maxBytes) chars--;
  return `${s.slice(0, chars)}…`;
}
