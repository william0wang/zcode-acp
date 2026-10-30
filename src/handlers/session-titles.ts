/**
 * Session-scoped `session.titleUpdated` listener (app-server 0.16.5; observed
 * live + schema-verified against the 3.12.3 desktop bundle, 2026-09-18).
 *
 * The backend pushes authoritative conversation-title changes:
 *
 *   { previousTitle, source: "default" | "first_input" | "generated" |
 *     "custom", title, messageID? }
 *
 * The bridge seeds a PROVISIONAL title from the first prompt (session.ts
 * set-once gate) and never consumed the backend's GENERATED title — the title
 * that lands after the first turn ends — so tabs, remote lists, and the
 * tasks-index kept the truncated prompt line forever. This listener adopts
 * the authoritative pushes:
 *
 *   - `generated` — the backend's LLM-generated title; replaces the
 *     provisional seed. This is the ONE allowed automatic rename: after the
 *     first adopted `generated` push (`server.autoTitleFinalized`) every later
 *     one is ignored. A manual user rename still wins at any time: sessions
 *     marked in `server.titleUserSetBy` (the remote rename endpoint and
 *     /rename mark them) are left untouched, and the durable
 *     `title_overridden` flag in tasks-index.sqlite is consulted for renames
 *     that predate this bridge process (the in-memory pin does not survive a
 *     restart).
 *   - `custom` — a title set by another surface (the desktop app over the
 *     same session store); adopted so every window stays consistent, and
 *     marked user-set so later `generated` pushes cannot override it.
 *   - `default` / `first_input` — nothing to adopt (the bridge already seeds
 *     the first_input form itself from the prompt text).
 *
 * Alias semantics: clients can hold DIFFERENT acpSids for one backend
 * conversation (`server.sessionAliases`) — the pin check, the title maps, and
 * the `session_info_update` broadcast all run over the FULL alias list, never
 * a single last-write-wins id.
 *
 * Best-effort throughout: failures are logged and never thrown into the
 * event loop.
 */

import { randomUUID } from "node:crypto";

import type { EventListener } from "../backend/client.js";
import type { ZcodeEvent } from "../backend/types.js";
import { isTitleOverridden, renameSessionTask, updateSessionTitle } from "../tasks-index.js";
import { refreshTerminalTabTitle } from "../terminal-title.js";
import type { ZcodeAcpServer } from "../server.js";
import { log, warn } from "../utils.js";
import { sendSessionUpdate } from "./io.js";

/** Payload of a `session.titleUpdated` event (schema-verified, see above). */
interface TitleUpdatedPayload {
  source?: unknown;
  title?: unknown;
  previousTitle?: unknown;
  messageID?: unknown;
}

/** Mirror the auto-title/rename normalization: single line, trimmed, 80 chars. */
function normalizeTitle(raw: string): string {
  return raw
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 80);
}

/** v4/command budget — the gateway may cold-resume an idle session first. */
const RENAME_COMMAND_TIMEOUT_MS = 10_000;

/** Best-effort notify: never throws, never blocks the caller's response. */
async function sendBackendRename(
  server: ZcodeAcpServer,
  zcodeSid: string,
  title: string,
): Promise<void> {
  try {
    const backend = await server.ensureBackend();
    const resp = await backend.request(
      server.nextId(),
      "v4/command",
      {
        commandId: randomUUID(),
        clientId: "zcode-acp-server",
        sessionId: zcodeSid,
        type: "renameSession",
        payload: { title },
        issuedAt: Date.now(),
      },
      RENAME_COMMAND_TIMEOUT_MS,
    );
    if (resp.error) {
      warn(
        `rename: backend v4 renameSession rejected (non-fatal): ` +
          `${resp.error.message ?? "unknown error"}`,
      );
    }
  } catch (e) {
    warn(
      `rename: backend v4 renameSession failed (non-fatal): ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Unified manual rename — the single write path behind the remote rename
 * endpoint and the /rename slash command. A rename is the ONLY title change
 * allowed after the one-shot auto title, and it must reach EVERY surface:
 *
 *   - this bridge: `sessionTitles` + `titleUserSetBy` pin + discovery summary
 *     for the FULL alias group (`sessionAliases` — clients hold different
 *     acpSids for one conversation), and the terminal tab title;
 *   - the backend: v4 `renameSession` command → `titleSource=custom` (sticky
 *     — the backend never auto-generates over it again). Without this the
 *     backend store keeps the old title and resurrects it through
 *     `session/list` adoption and resume title re-emission. AWAITED (bounded
 *     by the 10s command budget): the gateway cold-resumes non-resident
 *     sessions, and the caller's response must not beat the store — the
 *     client's immediate re-read of the list would otherwise flip the fresh
 *     title back (older backends without the command degrade to warn + the
 *     bridge-side pins);
 *   - the App's tasks-index: `renameSessionTask` pins `title_overridden=1`,
 *     which `adoptStoredTitle` consults to survive bridge restarts;
 *   - attached clients: a `session_info_update` broadcast per alias (the
 *     backend's own `custom` push for the same title is deduped by the
 *     listener's equality guard).
 *
 * A placeholder session (no backend id yet) is pinned in memory only; its
 * materialization re-runs this core to persist the rename (see
 * `ensureRealSession`).
 */
export async function renameSessionCore(
  server: ZcodeAcpServer,
  acpSid: string,
  rawTitle: string,
): Promise<{ title: string }> {
  const title = normalizeTitle(rawTitle);
  if (!title) throw new Error("rename: empty title");
  const zcodeSid = server.resolveSid(acpSid);
  for (const sid of server.sessionAliases(acpSid)) {
    server.sessionTitles.set(sid, title);
    // Wins over every later automatic path: generated pushes (this pin and
    // the freeze set), the first-prompt auto-title gate (sessionTitles.has).
    server.titleUserSetBy.add(sid);
    server.titleEligibleSessions.delete(sid);
    // A rename must not resurrect an alias retired by a remote close
    // (ADR-0006) — same guard as the listener's adoption loop.
    if (!server.discoveryRetiredAt.has(sid)) server.touchSessionSummary(sid, title);
    refreshTerminalTabTitle(server, sid);
  }
  if (zcodeSid) {
    // Manual intent finalizes the auto-title phase regardless of whether a
    // generated push was ever seen.
    server.autoTitleFinalized.add(zcodeSid);
    // AWAIT both persists: the response must not beat the backend store.
    // The phone/editor re-reads the session list right after a rename, and
    // `listSessions` serves backend titles — answering before the v4 command
    // landed flipped the fresh title back to the stale one (the command may
    // cold-resume an idle session first, hence the 10s budget). Both are
    // best-effort: on failure the bridge-side pins above still hold and the
    // listing overlay (overriddenTaskTitles) covers the read side.
    await sendBackendRename(server, zcodeSid, title);
    await renameSessionTask(zcodeSid, title).catch((e) =>
      warn(
        `rename: tasks-index persist failed (non-fatal): ` +
          `${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }
  for (const sid of server.sessionAliases(acpSid)) {
    void sendSessionUpdate(server.clients.broadcast(), sid, {
      sessionUpdate: "session_info_update",
      title,
      updatedAt: new Date().toISOString(),
    }).catch((e) =>
      log(
        `rename: session_info_update broadcast failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }
  log(`rename: session ${acpSid.slice(0, 8)} → "${title}"`);
  return { title };
}

export class SessionTitleListener implements EventListener {
  private readonly server: ZcodeAcpServer;
  readonly zcodeSid: string;

  constructor(server: ZcodeAcpServer, zcodeSid: string) {
    this.server = server;
    this.zcodeSid = zcodeSid;
  }

  handleEvent(event: ZcodeEvent): void {
    if (event.type !== "session.titleUpdated") return;
    // Async: the durable-pin consult reads sqlite. Title pushes are rare, so
    // the (bounded) await before adopting is fine; every failure path logs.
    void this.onTitleUpdated(event.payload as TitleUpdatedPayload).catch((e) =>
      log(
        `SessionTitleListener: title update failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }

  private async onTitleUpdated(p: TitleUpdatedPayload): Promise<void> {
    const source = p.source;
    if (source !== "generated" && source !== "custom") return;
    if (typeof p.title !== "string") return;
    const title = normalizeTitle(p.title);
    if (!title) return;

    const primary = this.server.resolveAcpSid(this.zcodeSid);
    if (!primary) return; // no ACP alias attached yet — nothing to update
    const aliases = this.server.sessionAliases(primary);

    // Auto naming happens EXACTLY ONCE: the first `generated` push (replacing
    // the provisional seed) is the only automatic title change a conversation
    // ever gets. Later pushes — deferred sidecar results, resume re-emission
    // after the stored event rotated out of the retention window — must not
    // retitle a conversation mid-flight. Checked BEFORE the durable pin
    // consult so a repeat push costs no sqlite read.
    if (source === "generated" && this.server.autoTitleFinalized.has(this.zcodeSid)) return;

    // A manual rename is the strongest title intent; a generated push must
    // not override it. The in-memory pin covers renames made through THIS
    // bridge; the durable tasks-index flag covers renames that predate the
    // process (a restart wipes the memory pin, `title_overridden` does not).
    let userPinned = aliases.some((sid) => this.server.titleUserSetBy.has(sid));
    if (!userPinned && source === "generated") {
      try {
        if (await isTitleOverridden(this.zcodeSid)) {
          userPinned = true;
          for (const sid of aliases) this.server.titleUserSetBy.add(sid);
        }
      } catch {
        // Best-effort consult — fall through and adopt.
      }
    }
    if (userPinned && source === "generated") return;
    // A `custom` push IS a manual rename (from another surface) — adopt and
    // pin it against later generated pushes.
    if (source === "custom") {
      for (const sid of aliases) this.server.titleUserSetBy.add(sid);
    }
    // Either adoption finalizes the auto-title phase for good.
    this.server.autoTitleFinalized.add(this.zcodeSid);

    if (aliases.every((sid) => this.server.sessionTitles.get(sid) === title)) return;

    for (const sid of aliases) {
      this.server.sessionTitles.set(sid, title);
      // A trailing title push from the dying conversation must not resurrect
      // an alias retired by a remote close (ADR-0006) — a summary recreated
      // here with a title would re-advertise it. The stamp clears on the
      // next genuine use (markSessionActive).
      if (this.server.discoveryRetiredAt.has(sid)) continue;
      this.server.touchSessionSummary(sid, title);
      refreshTerminalTabTitle(this.server, sid);
    }
    void updateSessionTitle(this.zcodeSid, title, title).catch((e) =>
      log(
        `SessionTitleListener: tasks-index persist failed (non-fatal): ${
          e instanceof Error ? e.message : String(e)
        }`,
      ),
    );
    // session_info_update per alias: clients route by the payload sessionId,
    // so a client holding a different alias would drop a single-id emit.
    for (const sid of aliases) {
      void sendSessionUpdate(this.server.clients.broadcast(), sid, {
        sessionUpdate: "session_info_update",
        title,
        updatedAt: new Date().toISOString(),
      }).catch((e) =>
        log(
          `SessionTitleListener: session_info_update broadcast failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        ),
      );
    }
    log(`  [title] adopted backend title (${source}): "${title}"`);
  }
}
