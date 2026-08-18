/**
 * Heartbeat-time session availability verification.
 *
 * A bridge can outlive a session's ownership: restarting a project window
 * leaks the old bridge process (Zed keeps it alive), and the new bridge takes
 * over the session via the durable alias store. The old bridge keeps
 * advertising the session in every heartbeat while its own backend subprocess
 * can no longer serve it — remote clients then see the same session twice,
 * and the stale copy opens empty. Before each hub heartbeat we probe idle
 * advertised sessions with a cheap `session/messages` RPC: an error or empty
 * answer marks the summary unavailable (dropped from the discovery payload,
 * and the backend-loaded stamp cleared so a later session/load re-runs the
 * resume RPC instead of skipping it); a non-empty answer restores it.
 * Freshly-active sessions and sessions with an in-flight turn are trusted
 * without a probe.
 */

import type { ZcodeAcpServer } from "../server.js";
import { log, warn } from "../utils.js";

/** Sessions touched within this window are trusted without a probe. */
const FRESH_MS = 60_000;
/** Per-probe cap — a hung backend must not stall the heartbeat loop. */
const PROBE_TIMEOUT_MS = 3000;

export async function verifySessionAvailability(server: ZcodeAcpServer): Promise<void> {
  const backend = server.backend;
  if (!backend || backend.isDead) return;

  const busyZcodeSids = new Set([...server.pendingTurns.values()].map((t) => t.zcodeSid));
  const now = Date.now();
  for (const [acpSid, summary] of server.sessionSummaries.entries()) {
    if (!summary.hasActivity) continue;
    // Fresh summaries are trusted; unavailable ones are re-probed so a session
    // that becomes serveable again returns to the discovery list.
    if (summary.unavailable !== true && now - summary.updatedAt < FRESH_MS) continue;
    const zcodeSid = server.resolveSid(acpSid);
    if (!zcodeSid || busyZcodeSids.has(zcodeSid)) continue;

    let serveable = false;
    try {
      const timer = new Promise<null>((resolve) => {
        const t = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS);
        t.unref();
      });
      const resp = await Promise.race([
        backend.request(
          server.nextId(),
          "session/messages",
          { sessionId: zcodeSid },
          PROBE_TIMEOUT_MS,
        ),
        timer,
      ]);
      const messages = ((resp?.result ?? {}) as { messages?: Array<unknown> }).messages ?? [];
      serveable = resp !== null && !resp.error && messages.length > 0;
    } catch {
      serveable = false;
    }

    if (serveable) {
      if (summary.unavailable) {
        summary.unavailable = false;
        log(`remote: session ${acpSid.slice(0, 8)} serves messages again - restored to discovery`);
      }
      continue;
    }
    if (!summary.unavailable) {
      summary.unavailable = true;
      // The loaded-in-this-subprocess stamp went stale (another backend took
      // the session over): a later session/load must re-run the resume RPC.
      server.backendLoadedSessions.delete(acpSid);
      warn(
        `remote: session ${acpSid.slice(0, 8)} not serveable by this backend - hidden from discovery`,
      );
    }
  }
}
