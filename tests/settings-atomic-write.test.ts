/**
 * file-lock.ts + atomic-write.ts tests.
 *
 * Both modules are filesystem-behavioural (lock directory identity, inode
 * replacement on rename, backup rotation), so these run against real temp
 * directories rather than a fake fs — the invariants under test ARE the
 * syscalls.
 *
 * The cross-process claim (ADR-0026) is exercised for real: the lock protocol
 * is the ZCode desktop app's, so what must hold is that a second, independent
 * holder is excluded while the first is inside its critical section, and that
 * a holder that dies mid-flight is reclaimed.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BACKUP_KEEP,
  backupStampToIso,
  encodeJson,
  listBackups,
  readJsonDocument,
  writeJsonAtomic,
  writeTextAtomic,
} from "../src/settings/atomic-write.js";
import { FILE_LOCK_TIMEOUT_ERROR_CODE, withFileLock } from "../src/settings/file-lock.js";

let root: string;
let file: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "settings-lock-test-"));
  file = path.join(root, "config.json");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// A lock held across an await boundary is what makes the whole thing necessary;
// without one the operation would complete before a contender could observe it.
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("withFileLock", () => {
  it("acquires and releases, leaving no lock directory behind", async () => {
    await withFileLock(file, async () => {
      expect(await readdir(root)).toContain(`${path.basename(file)}.lock`);
    });
    // The lock directory is removed on release — a leftover would be reclaimed
    // only after the grace window, adding latency to every later write.
    expect(await readdir(root)).not.toContain(`${path.basename(file)}.lock`);
  });

  it("serializes concurrent holders in the same process", async () => {
    const order: string[] = [];
    let inside = 0;
    let maxInside = 0;
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        withFileLock(file, async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          order.push(`start-${i}`);
          await tick();
          order.push(`end-${i}`);
          inside -= 1;
        }),
      ),
    );
    expect(maxInside).toBe(1);
    // Contiguity: a holder's `end` must be immediately followed by another
    // holder's `start`, never interleaved with a third entry.
    for (let i = 0; i < 5; i++) {
      const start = order.indexOf(`start-${i}`);
      expect(order[start + 1]).toBe(`end-${i}`);
    }
  });

  it("reclaims a lock whose owner process is gone", async () => {
    // Simulate a crashed holder: a lock directory with an owner file naming a
    // pid that does not exist. The next acquisition must not wait it out.
    const lockDir = `${file}.lock`;
    await mkdir(lockDir, { recursive: true });
    const deadPid = 0x7ffffffe; // positive safe integer, never a live process
    await writeFile(
      path.join(lockDir, `owner-${deadPid}-1-abc.json`),
      `${JSON.stringify({ pid: deadPid, createdAt: Date.now(), token: "t" })}\n`,
      "utf8",
    );
    const started = Date.now();
    await withFileLock(file, async () => undefined);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("times out rather than deleting a live holder's lock", async () => {
    // The cross-process case, exercised directly: another holder (here: this
    // process, which is alive) owns the lock. The acquire must time out
    // WITHOUT sweeping the holder's owner file.
    //
    // This is done at the OS-lock layer rather than through withFileLock
    // because the process-internal FIFO deliberately makes a second in-process
    // caller wait behind the first one's whole critical section — which would
    // hide the timeout path entirely.
    const lockDir = `${file}.lock`;
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      path.join(lockDir, `owner-${process.pid}-1-alive.json`),
      `${JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "t" })}\n`,
      "utf8",
    );
    await expect(
      withFileLock(file, async () => "never", {
        lockRetryDelaysMs: [20],
        lockMaxWaitMs: 150,
        lockOwnerlessGraceMs: 0,
      }),
    ).rejects.toMatchObject({ code: FILE_LOCK_TIMEOUT_ERROR_CODE });
    // The live holder's lock is still intact — the timeout never stole it.
    const owners = (await readdir(lockDir)).filter((e) => e.startsWith("owner-"));
    expect(owners).toEqual([`owner-${process.pid}-1-alive.json`]);
  });

  it("waits for a live holder instead of stealing its lock", async () => {
    // The complement: with a cap longer than the holder's critical section,
    // the contender acquires afterwards and both operations complete in order.
    const order: string[] = [];
    let release!: () => void;
    const first = withFileLock(file, async () => {
      order.push("first-in");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push("first-out");
    });
    await tick();
    const second = withFileLock(file, async () => {
      order.push("second-in");
    });
    // Let the contender enter its retry loop before the holder lets go.
    await new Promise((r) => setTimeout(r, 60));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-in", "first-out", "second-in"]);
  });

  it("ignores an owner file whose pid is unusable after the grace window", async () => {
    // pid 0 is not a valid owner: it must be treated as ownerless, so the lock
    // becomes stale after the grace window instead of looking alive forever.
    const lockDir = `${file}.lock`;
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      path.join(lockDir, "owner-x.json"),
      `${JSON.stringify({ pid: 0, createdAt: Date.now() - 60_000, token: "t" })}\n`,
      "utf8",
    );
    const started = Date.now();
    await withFileLock(file, async () => undefined, {
      lockRetryDelaysMs: [20],
      lockMaxWaitMs: 3000,
      lockOwnerlessGraceMs: 50,
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("readJsonDocument", () => {
  it("returns null for an absent file", async () => {
    expect(await readJsonDocument(file)).toBeNull();
  });

  it("throws on a corrupt file instead of returning an empty document", async () => {
    await writeFile(file, "{ not json", "utf8");
    await expect(readJsonDocument(file)).rejects.toThrow(/not valid JSON/);
  });

  it("throws when the document is not an object", async () => {
    await writeFile(file, "[1,2,3]", "utf8");
    await expect(readJsonDocument(file)).rejects.toThrow(/not a JSON object/);
  });
});

describe("writeJsonAtomic", () => {
  it("creates the file with 2-space indentation and a trailing newline", async () => {
    const { doc } = await writeJsonAtomic(file, () => ({ a: 1, b: { c: 2 } }));
    expect(doc).toEqual({ a: 1, b: { c: 2 } });
    const raw = await readFile(file, "utf8");
    expect(raw).toBe('{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}\n');
    expect(encodeJson({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });

  it("preserves keys the mutator never mentioned", async () => {
    await writeFile(
      file,
      encodeJson({
        skills: { "/x/SKILL.md": { enable: false } },
        mcp: { servers: { keep: { command: "k" } } },
        plugins: { enabledPlugins: { "p@m": true } },
      }),
      "utf8",
    );
    await writeJsonAtomic(file, (cur) => ({ ...cur, added: true }));
    const after = await readJsonDocument(file);
    expect(after).toEqual({
      skills: { "/x/SKILL.md": { enable: false } },
      mcp: { servers: { keep: { command: "k" } } },
      plugins: { enabledPlugins: { "p@m": true } },
      added: true,
    });
  });

  it("refuses to write over a corrupt file", async () => {
    await writeFile(file, "{ broken", "utf8");
    await expect(writeJsonAtomic(file, () => ({ fresh: true }))).rejects.toThrow(
      /refusing to write/,
    );
    // The damaged bytes are untouched — a later recovery may still read them.
    expect(await readFile(file, "utf8")).toBe("{ broken");
  });

  it("does not touch the file when validation fails", async () => {
    await writeFile(file, encodeJson({ keep: 1 }), "utf8");
    await expect(
      writeJsonAtomic(file, () => ({ keep: 1, bad: true }), {
        validate: (doc) => (doc.bad ? "bad is not allowed" : true),
      }),
    ).rejects.toThrow(/bad is not allowed/);
    expect(await readJsonDocument(file)).toEqual({ keep: 1 });
    // No backup either — nothing was replaced.
    expect(await listBackups(file)).toHaveLength(0);
  });

  it("backs up the previous content and rotates to the newest N", async () => {
    await writeFile(file, encodeJson({ gen: 0 }), "utf8");
    for (let i = 1; i <= BACKUP_KEEP + 3; i++) {
      const { backup } = await writeJsonAtomic(file, (cur) => ({
        ...cur,
        gen: (cur.gen as number) + 1,
      }));
      expect(backup).toMatch(/\.bak-/);
      // The stamp is millisecond-resolution; without spacing, two writes in
      // the same millisecond collide on one backup name and the count drops.
      await new Promise((r) => setTimeout(r, 2));
    }
    const backups = await listBackups(file);
    expect(backups).toHaveLength(BACKUP_KEEP);
    expect(await readJsonDocument(file)).toEqual({ gen: BACKUP_KEEP + 3 });
    // The newest backup holds the content from just before the final write.
    const newest = await readFile(backups[0]!.path, "utf8");
    expect(JSON.parse(newest)).toEqual({ gen: BACKUP_KEEP + 2 });
  });

  it("reports no backup on a first write", async () => {
    const { backup } = await writeJsonAtomic(file, () => ({ first: true }));
    expect(backup).toBeUndefined();
    expect(await listBackups(file)).toHaveLength(0);
  });

  it("creates the parent directory when missing", async () => {
    const nested = path.join(root, "a", "b", "config.json");
    await writeJsonAtomic(nested, () => ({ ok: true }));
    expect(await readJsonDocument(nested)).toEqual({ ok: true });
  });

  it("replaces the file atomically (new inode, never a torn document)", async () => {
    await writeFile(file, encodeJson({ v: 1 }), "utf8");
    const before = (await stat(file)).ino;
    await writeJsonAtomic(file, () => ({ v: 2 }));
    const after = (await stat(file)).ino;
    expect(after).not.toBe(before);
  });

  it("leaves no temp files behind", async () => {
    await writeJsonAtomic(file, () => ({ done: true }));
    const leftovers = (await readdir(root)).filter((e) => e.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("writeTextAtomic", () => {
  it("replaces a text file atomically and leaves no temp file", async () => {
    const md = path.join(root, "agent.md");
    await writeTextAtomic(md, "---\nname: a\n---\nbody\n");
    const before = (await stat(md)).ino;
    await writeTextAtomic(md, "---\nname: b\n---\nbody\n");
    expect((await stat(md)).ino).not.toBe(before);
    expect(await readFile(md, "utf8")).toBe("---\nname: b\n---\nbody\n");
    expect((await readdir(root)).filter((e) => e.endsWith(".tmp"))).toEqual([]);
  });

  it("backs up the previous content before replacing it", async () => {
    const md = path.join(root, "agent.md");
    await writeTextAtomic(md, "first");
    await writeTextAtomic(md, "second");
    const backups = (await readdir(root)).filter((e) => e.startsWith("agent.md.bak-"));
    expect(backups).toHaveLength(1);
    expect(await readFile(path.join(root, backups[0]!), "utf8")).toBe("first");
  });

  it("creates the parent directory when missing", async () => {
    const nested = path.join(root, "x", "y", "agent.md");
    await writeTextAtomic(nested, "body");
    expect(await readFile(nested, "utf8")).toBe("body");
  });
});

describe("backupStampToIso", () => {
  it("rebuilds a readable timestamp without corrupting the date", () => {
    // The bug this guards: replacing every '-' with ':' also mangles the date,
    // yielding `2026:09:22T14:10:00.000Z` — an Invalid Date for every consumer.
    const stamp = "2026-09-22T14-10-00-000Z";
    const iso = backupStampToIso(stamp);
    expect(iso).toBe("2026-09-22T14:10:00.000Z");
    expect(Number.isNaN(new Date(iso).getTime())).toBe(false);
  });

  it("round-trips a stamp produced by the real backup path", async () => {
    // Two writes: the first creates the file (nothing to back up), the second
    // takes the backup whose stamp this then reads back.
    await writeJsonAtomic(file, () => ({ a: 1 }));
    await writeJsonAtomic(file, () => ({ a: 2 }));
    const [backup] = await listBackups(file);
    expect(backup).toBeDefined();
    expect(Number.isNaN(new Date(backup!.createdAt).getTime())).toBe(false);
    expect(backup!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  });
});

describe("encodeJson", () => {
  it("is stable for key order given by the object", () => {
    expect(encodeJson({ b: 1, a: 2 })).toBe('{\n  "b": 1,\n  "a": 2\n}\n');
  });
});
