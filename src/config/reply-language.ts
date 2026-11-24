/**
 * Agent reply-language setting for the CLI's `session/readReplyLanguage` ask.
 *
 * The desktop host answers that request from memory (packages/desktop/src/main/
 * index.ts:1323, :2368); the bridge's equivalent is this live read of
 * <zcode-home>/v2/setting.json. No memoization: the backend re-reads on EVERY
 * input-attachment collection on main turns (apps/zcode-cli/packages/core/src/
 * runtime/methods/context-refresh.ts:140-165) and the desktop app can change
 * the value at any time.
 *
 * NO validation beyond "non-empty string" — pass the value through verbatim.
 * The backend's own schema (replyLanguageSchema, trimmed 1..max) is the only
 * validator; an out-of-range hand-edited value makes the backend skip that one
 * announcement (a failed read only logs at debug, never affects the turn).
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { zcodeHomeDir } from "../utils.js";

/** The configured reply language, or null when unset/unreadable. Never throws. */
export function readReplyLanguage(): string | null {
  try {
    const raw = readFileSync(path.join(zcodeHomeDir(), "v2", "setting.json"), "utf8");
    // Editors saving UTF-8 with a BOM leave \uFEFF in the string; JSON.parse
    // rejects it — same strip as appLocale() in src/i18n.ts.
    const bomless = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = JSON.parse(bomless) as { replyLanguage?: unknown };
    return typeof parsed.replyLanguage === "string" && parsed.replyLanguage.length > 0
      ? parsed.replyLanguage
      : null;
  } catch {
    return null; // file absent / unreadable / malformed JSON
  }
}
