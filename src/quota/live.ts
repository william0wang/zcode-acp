/**
 * Quota dock refresher (ADR-0021) — keeps the Martty TUI's resident quota line
 * up to date.
 *
 * A lazy process-wide singleton: started on first martty session activity, it
 * refreshes every 60s and on every forceRefresh() (wired at turn end). Each
 * successful refresh stores the formatted string on `server.quotaDock` and
 * pushes a `config_option_update` (full options array — martty's subscribe is
 * full-replace semantics) to the martty connections only.
 *
 * Cross-process sharing is hub-first: when the remote hub is reachable, its
 * cached /api/quota/dock endpoint serves the string (~500ms budget); any
 * failure falls back silently to a direct queryQuota() — the fallback is the
 * normal path for local-only users (the hub is opt-in and idle-exits).
 */

import type * as acp from "@agentclientprotocol/sdk";

import { buildConfigOptions } from "../config/options.js";
import { parseRemoteConfig } from "../remote/config.js";
import { log, warn } from "../utils.js";
import type { ZcodeAcpServer } from "../server.js";
import { enqueueSessionSend } from "../handlers/io.js";
import { formatQuotaDock } from "./format.js";
import { queryQuota } from "./index.js";

/** Interval between background refreshes. */
export const QUOTA_REFRESH_INTERVAL_MS = 60_000;
/** Budget for the hub-first lookup before falling back to a direct query. */
const HUB_TIMEOUT_MS = 500;

interface RefresherState {
  server: ZcodeAcpServer;
  timer: ReturnType<typeof setInterval>;
  /** Collapses concurrent refreshes (interval + forceRefresh) into one fetch. */
  inFlight: Promise<void> | null;
}

let state: RefresherState | null = null;

/**
 * Start the refresher (idempotent). No-op unless a martty client has been
 * seen — editor-only setups never poll the quota API in the background.
 */
export function startQuotaRefresher(server: ZcodeAcpServer): void {
  if (state || !server.marttyClientSeen) return;
  const entry: RefresherState = {
    server,
    timer: setInterval(() => void refresh(entry), QUOTA_REFRESH_INTERVAL_MS),
    inFlight: null,
  };
  entry.timer.unref?.();
  state = entry;
  void refresh(entry);
}

/** Best-effort immediate refresh (called at every turn end). Never rejects. */
export function forceRefreshQuota(): Promise<void> {
  if (!state) return Promise.resolve();
  return refresh(state);
}

/** Stop and forget the singleton (test helper). */
export function resetQuotaRefresherForTest(): void {
  if (state) clearInterval(state.timer);
  state = null;
}

async function refresh(entry: RefresherState): Promise<void> {
  if (entry.inFlight) return entry.inFlight;
  entry.inFlight = runRefresh(entry.server)
    .catch((e) => {
      log(`quota-dock: refresh failed (${e instanceof Error ? e.message : String(e)})`);
    })
    .finally(() => {
      entry.inFlight = null;
    });
  return entry.inFlight;
}

async function runRefresh(server: ZcodeAcpServer): Promise<void> {
  const text = await fetchDockText();
  // ADR-0021: sticky last-known on failure/no-data — a null window would
  // poison every other mid-turn config_option_update (buildConfigOptions
  // reads server.quotaDock) into dropping the quota pseudo-option, erasing
  // the dock line mid-stream until the next successful fetch. The dock hides
  // only when no refresh has ever succeeded (quotaDock stays null, so the
  // option is never attached). No update is emitted for a failed fetch.
  if (text === null) return;
  const prev = server.quotaDock;
  server.quotaDock = text;
  if (text === prev) return;
  await emitQuotaOptions(server);
}

/** Hub-first dock string, falling back to a direct query. */
export async function fetchDockText(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const remote = parseRemoteConfig(env);
  if (remote) {
    try {
      const resp = await fetch(`http://${remote.hubHost}:${remote.hubPort}/api/quota/dock`, {
        headers: { Authorization: `Bearer ${remote.token}` },
        signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
      });
      if (resp.ok) {
        const body = (await resp.json()) as { formatted?: unknown };
        if (body.formatted === null) return null;
        if (typeof body.formatted === "string") return body.formatted;
      }
    } catch {
      // hub absent/restarting — silent fallback below
    }
  }
  return formatQuotaDock(await queryQuota());
}

/**
 * Push a `config_option_update` carrying the full options array (quota
 * included) to every martty connection, for every live session alias. Other
 * clients are untouched — the quota option is martty-only by contract.
 */
async function emitQuotaOptions(server: ZcodeAcpServer): Promise<void> {
  if (server.marttyConnectionRoots.size === 0) return;
  const targets = server.clients
    .snapshot()
    .filter((cx) => server.marttyConnectionRoots.has(connectionRootOf(cx)));
  if (targets.length === 0) return;

  // Build the options once per zcode session (aliases share the same list).
  const byZcodeSid = new Map<string | null, acp.SessionConfigOption[]>();
  const emitFor = async (acpSid: string): Promise<void> => {
    const zcodeSid = server.resolveSid(acpSid) ?? null;
    let options = byZcodeSid.get(zcodeSid);
    if (!options) {
      // All targets are martty connections by construction — any target's
      // root unlocks the quota pseudo-option for the shared options array.
      options = await buildConfigOptions(server, zcodeSid, connectionRootOf(targets[0]!));
      byZcodeSid.set(zcodeSid, options);
    }
    await enqueueSessionSend(acpSid, async () => {
      const results = await Promise.allSettled(
        targets.map((cx) =>
          cx.notify("session/update", {
            sessionId: acpSid,
            update: { sessionUpdate: "config_option_update", configOptions: options },
          }),
        ),
      );
      for (const r of results) {
        if (r.status === "rejected") {
          warn(
            `quota-dock: config_option_update failed on one client: ` +
              `${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
          );
        }
      }
    });
  };

  const acpSids = [...server.sessionMap.keys(), ...server.pendingSessions.keys()];
  for (const acpSid of acpSids) await emitFor(acpSid);
}

/** clientConnectionRoot equivalent for a raw ClientLike (see utils.ts). */
function connectionRootOf(cx: unknown): unknown {
  return (cx as { connectionContext?: unknown }).connectionContext;
}
