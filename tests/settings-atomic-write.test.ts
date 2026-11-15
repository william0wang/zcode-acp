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
  encodeJson,
  listBackups,
  readJsonDocument,
  writeJsonAtomic,
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
});

describe("readJsonDocument", () => {
  it("throws on a corrupt file instead of returning an empty document", async () => {
    await writeFile(file, "{ not json", "utf8");
    await expect(readJsonDocument(file)).rejects.toThrow(/not valid JSON/);
  });
});

describe("writeJsonAtomic", () => {
  it("refuses to write over a corrupt file", async () => {
    await writeFile(file, "{ broken", "utf8");
    await expect(writeJsonAtomic(file, () => ({ fresh: true }))).rejects.toThrow(
      /refusing to write/,
    );
    // The damaged bytes are untouched — a later recovery may still read them.
    expect(await readFile(file, "utf8")).toBe("{ broken");
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
