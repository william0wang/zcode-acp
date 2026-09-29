/**
 * WeCom push configuration + the single shared ACTIVE predicate
 * (push-backend-requirements §6/§8/§10).
 *
 * Precedence mirrors `mergeCommon` (file > env): the `push` section of
 * ~/.config/zcode-acp/config.json wins over the ZCODE_ACP_PUSH_* env vars.
 * ACTIVE = enabled AND complete credentials (corpId/agentId/secret) — a push
 * that cannot summon anyone must not hold an offline interaction either, so
 * `pushIfOffline` and the interaction hold read the SAME predicate.
 *
 * Resolved lazily ONCE per process: an enabled-but-incomplete setup logs one
 * warning at first resolution and every hook then no-ops (silent degradation).
 */

import { loadUserConfig } from "../config/user-config.js";
import { warn } from "../utils.js";

export interface PushConfig {
  corpId: string;
  agentId: number;
  secret: string;
  toUser: string;
  contentDetail: "full" | "minimal";
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
  return { corpId, agentId, secret, toUser, contentDetail: file.contentDetail ?? "full" };
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
