/**
 * The durable remote-close record (ADR-0006 persistence amendment): every id
 * spelling of a remotely closed conversation, cleared on genuine use. The
 * in-memory retirement stamp dies with the serve bridge's self-exit — this
 * store is what lets the hub-incubated successor still refuse to resurrect
 * the conversation on a reconnect ladder's auto session/load.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  clearClosedSessionIds,
  isClosedSessionId,
  recordClosedSessionIds,
} from "../src/closed-sessions.js";
import { zcodeHomeDir } from "../src/utils.js";

function storeFile(): string {
  return path.join(zcodeHomeDir(), "v2", "acp-closed-sessions.json");
}

beforeEach(() => {
  rmSync(storeFile(), { force: true });
});

describe("closed-sessions store", () => {
  it("records every spelling and answers membership for each", () => {
    recordClosedSessionIds(["alias-1", "alias-2", "sess_backend"]);
    expect(isClosedSessionId("alias-1")).toBe(true);
    expect(isClosedSessionId("alias-2")).toBe(true);
    expect(isClosedSessionId("sess_backend")).toBe(true);
    expect(isClosedSessionId("never-recorded")).toBe(false);
  });

  it("genuine use clears the conversation's spellings and no one else's", () => {
    recordClosedSessionIds(["alias-1", "sess_backend"]);
    recordClosedSessionIds(["other"]);
    clearClosedSessionIds(["alias-1", "sess_backend"]);
    expect(isClosedSessionId("alias-1")).toBe(false);
    expect(isClosedSessionId("sess_backend")).toBe(false);
    expect(isClosedSessionId("other")).toBe(true);
  });

  it("a clear with nothing recorded is a semantic no-op", () => {
    recordClosedSessionIds(["kept"]);
    clearClosedSessionIds(["unknown-sid"]);
    // The untouched record survives: the no-op clear dropped nothing.
    expect(isClosedSessionId("kept")).toBe(true);
  });

  it("entries older than the TTL expire (stale records must not retire a desktop-side reopen forever)", () => {
    recordClosedSessionIds(["stale"]);
    // Forge an aged entry directly: the record's schema is {sid: closedAt}.
    writeFileSync(storeFile(), JSON.stringify({ ancient: Date.now() - 31 * 24 * 60 * 60 * 1000 }));
    expect(isClosedSessionId("ancient")).toBe(false);
    expect(isClosedSessionId("missing-file-sid")).toBe(false);
  });

  it("a corrupt store reads as nothing closed — never fatal", () => {
    mkdirSync(path.dirname(storeFile()), { recursive: true });
    writeFileSync(storeFile(), "{not json");
    expect(isClosedSessionId("any")).toBe(false);
    // And recording on top of the corrupt file heals it.
    recordClosedSessionIds(["healed"]);
    expect(isClosedSessionId("healed")).toBe(true);
  });

  it("empty / malformed ids are ignored", () => {
    recordClosedSessionIds([undefined, "", "ok"]);
    expect(isClosedSessionId("ok")).toBe(true);
    expect(isClosedSessionId(undefined)).toBe(false);
    expect(isClosedSessionId("")).toBe(false);
    clearClosedSessionIds([undefined, ""]);
  });
});
