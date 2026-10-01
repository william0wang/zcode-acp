/**
 * The workflow directory watch (desktop hub parity): a change under either
 * workflow dir fans out ONE debounced `$/zcode/workflowListChanged` to every
 * attached client — whatever touched the file (save tool, settings write,
 * direct edit). Real tmp dirs + a real FSWatcher; the global dir rides the
 * hermetic HOME.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ZcodeAcpServer } from "../src/server.js";
import { armWorkflowListWatch, WORKFLOW_LIST_CHANGED } from "../src/workflow/list-watch.js";

let home: string;
const notes: string[] = [];

beforeEach(() => {
  home = path.join(
    tmpdir(),
    `workflow-list-watch-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  vi.stubEnv("HOME", home);
  mkdirSync(path.join(home, ".zcode", "workflows"), { recursive: true });
  notes.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("workflow list watch", () => {
  it("fans one debounced notification to attached clients on a dir change", async () => {
    const server = new ZcodeAcpServer();
    server.clients.add({
      notify: async (method: string) => {
        notes.push(method);
      },
      request: async () => undefined,
    });
    armWorkflowListWatch(server);

    // A save burst (write + a second touch) must collapse into ONE ping.
    const file = path.join(home, ".zcode", "workflows", "deploy.dwf.ts");
    writeFileSync(file, "export default {};");
    writeFileSync(file, "export default { v: 2 };");

    await new Promise((r) => setTimeout(r, 2_200));
    expect(notes).toEqual([WORKFLOW_LIST_CHANGED]);
  });
});
