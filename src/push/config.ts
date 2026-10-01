/**
 * WeCom push configuration + the single shared ACTIVE predicate
 * (push-backend-requirements §6/§8/§10).
 *
 * Precedence mirrors `mergeCommon` (file > env): the `push` section of
 * ~/.config/zcode-acp/config.json wins over the ZCODE_ACP_PUSH_* env vars.
 * ACTIVE = enabled AND complete credentials (corpId/agentId/secret) — a push
 * that cannot summon anyone must not hold an offline interaction either, so
 * `pushIfOffline` and the interaction hold read the SAME predicate. An
 * OPTIONAL relay (static-IP proxy for the WeCom API) rides along when both
 * url+token are present; a half-configured relay warns once and pushes direct.
 *
 * Resolved lazily ONCE per process: an enabled-but-incomplete setup logs one
 * warning at first resolution and every hook then no-ops (silent degradation).
 */

import { loadUserConfig } from "../config/user-config.js";
import { warn } from "../utils.js";

export interface PushRelayConfig {
  /** Base URL (trailing slashes stripped); calls go to `${url}/cgi-bin/…`. */
  url: string;
  /** Shared secret sent as `x-relay-token` on every relayed call. */
  token: string;
}

/** Per-kind switches for settled-event push (§5.2) — default all ON. */
export interface PushNotifyConfig {
  turn: boolean;
  goal: boolean;
  run: boolean;
  task: boolean;
  compact: boolean;
  /** Pending interaction asks (§5.1): zero-client push + the unanswered watchdog. */
  ask: boolean;
}

/** Default quiet window for settled pushes (§5.2): user active → no ping. */
export const PUSH_QUIET_WINDOW_MS = 30_000;

/** Default unanswered-ask watchdog delay (§5.1 v1.3): push if still pending. */
export const PUSH_ASK_WATCHDOG_MS = 120_000;

/**
 * Default unanswered PERMISSION-ask watchdog: a permission ask BLOCKS a
 * running tool on a human answer — the 120s question window reads as "no
 * notification" for two full minutes on a popup the user never saw
 * (observed 2026-10-01 on workflow approvals). Questions (AskUserQuestion)
 * keep the long window; `permissionAskDelayMs` tunes this tier alone.
 */
export const PUSH_PERMISSION_ASK_WATCHDOG_MS = 15_000;

export interface PushConfig {
  corpId: string;
  agentId: number;
  secret: string;
  toUser: string;
  contentDetail: "full" | "minimal";
  /** Static-IP relay for the WeCom API (企业可信IP needs a stable source). */
  relay?: PushRelayConfig;
  /** Settled-event switches, file-only (`push.notify`), every kind default true. */
  notify: PushNotifyConfig;
  /**
   * Suppress a settled push within this many ms of the last user
   * prompt/cancel (§5.2 quiet window); 0 disables. File-only, default
   * {@link PUSH_QUIET_WINDOW_MS}.
   */
  quietMs: number;
  /**
   * Unanswered-ask watchdog delay (§5.1 v1.3): push a pending interaction ask
   * after this many ms with no answer, clients connected or not; 0 pushes at
   * dispatch time. File-only, default {@link PUSH_ASK_WATCHDOG_MS}.
   */
  askDelayMs: number;
  /**
   * Same watchdog for PERMISSION asks specifically (a blocked tool call):
   * file-only, default {@link PUSH_PERMISSION_ASK_WATCHDOG_MS}.
   */
  permissionAskDelayMs: number;
}

/** Same truthy set as `remoteEnabledLive` (remote/config.ts). */
const TRUTHY = ["1", "true", "yes", "on"];

export function resolvePushConfig(env: NodeJS.ProcessEnv): PushConfig | null {
  const file = loadUserConfig(env).push ?? {};
  const enabled =
    file.enabled !== undefined
      ? file.enabled
      : TRUTHY.includes((env.ZCODE_ACP_PUSH_ENABLED ?? "").trim().toLowerCase());
  if (!enabled) return null;
  const corpId = file.corpId ?? (env.ZCODE_ACP_PUSH_CORP_ID ?? "").trim();
  const secret = file.secret ?? (env.ZCODE_ACP_PUSH_SECRET ?? "").trim();
  const toUser = file.toUser ?? ((env.ZCODE_ACP_PUSH_TO_USER ?? "").trim() || "@all");
  const agentId = file.agentId ?? Number.parseInt((env.ZCODE_ACP_PUSH_AGENT_ID ?? "").trim(), 10);
  if (!corpId || !Number.isInteger(agentId) || agentId < 1 || !secret) {
    warn(
      "push: enabled but corpId/agentId/secret incomplete " +
        "(config file or ZCODE_ACP_PUSH_* env) — push stays inactive",
    );
    return null;
  }
  const relayUrl = trimTrailingSlashes(file.relay?.url ?? env.ZCODE_ACP_PUSH_RELAY_URL ?? "");
  const relayToken = file.relay?.token ?? (env.ZCODE_ACP_PUSH_RELAY_TOKEN ?? "").trim();
  const notify = {
    turn: file.notify?.turn !== false,
    goal: file.notify?.goal !== false,
    run: file.notify?.run !== false,
    task: file.notify?.task !== false,
    compact: file.notify?.compact !== false,
    ask: file.notify?.ask !== false,
  };
  const quietMs =
    file.quietMs !== undefined && file.quietMs >= 0 ? file.quietMs : PUSH_QUIET_WINDOW_MS;
  const askDelayMs =
    file.askDelayMs !== undefined && file.askDelayMs >= 0 ? file.askDelayMs : PUSH_ASK_WATCHDOG_MS;
  const permissionAskDelayMs =
    file.permissionAskDelayMs !== undefined && file.permissionAskDelayMs >= 0
      ? file.permissionAskDelayMs
      : PUSH_PERMISSION_ASK_WATCHDOG_MS;
  if (relayUrl && relayToken) {
    return {
      corpId,
      agentId,
      secret,
      toUser,
      contentDetail: file.contentDetail ?? "full",
      relay: { url: relayUrl, token: relayToken },
      notify,
      quietMs,
      askDelayMs,
      permissionAskDelayMs,
    };
  }
  if (relayUrl || relayToken) {
    warn(
      "push: relay needs BOTH url and token (config file push.relay or " +
        "ZCODE_ACP_PUSH_RELAY_* env) — pushing direct from this host",
    );
  }
  return {
    corpId,
    agentId,
    secret,
    toUser,
    contentDetail: file.contentDetail ?? "full",
    notify,
    quietMs,
    askDelayMs,
    permissionAskDelayMs,
  };
}

function trimTrailingSlashes(s: string): string {
  return s.trim().replace(/\/+$/, "");
}

/** undefined = not yet resolved; null = resolved inactive. */
let cached: PushConfig | null | undefined;

/** The shared ACTIVE predicate (resolve-once per process). */
export function pushActive(): boolean {
  if (cached === undefined) cached = resolvePushConfig(process.env);
  return cached !== null;
}

/** The resolved config when ACTIVE, null otherwise (resolves on first use). */
export function pushConfig(): PushConfig | null {
  if (cached === undefined) cached = resolvePushConfig(process.env);
  return cached ?? null;
}

/** Test hook: forget the process-wide resolution. */
export function resetPushConfigForTests(): void {
  cached = undefined;
}
