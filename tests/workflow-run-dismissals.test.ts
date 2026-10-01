/**
 * Workflow-run dismissal store unit tests. The suite's hermetic HOME makes
 * the store file disposable per file run; ids are still unique per test to
 * stay order-independent.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { dismissedRunIds, dismissWorkflowRunIds } from "../src/settings/workflow-run-dismissals.js";
import { zcodeHomeDir } from "../src/utils.js";

function storeFile(): string {
  return path.join(zcodeHomeDir(), "v2", "acp-workflow-run-dismissals.json");
}

describe("workflow-run dismissal store", () => {
  it("adds new ids, persists them, and treats repeats as no-ops", () => {
    expect(dismissWorkflowRunIds(["d-a", "d-b"])).toBe(2);
    expect(dismissWorkflowRunIds(["d-b", "d-c"])).toBe(1);

    const ids = dismissedRunIds();
    expect(ids.has("d-a")).toBe(true);
    expect(ids.has("d-b")).toBe(true);
    expect(ids.has("d-c")).toBe(true);

    // Persisted as JSON on disk — the restart-survival contract.
    const raw = JSON.parse(readFileSync(storeFile(), "utf8")) as Record<string, number>;
    expect(Object.keys(raw).sort()).toEqual(["d-a", "d-b", "d-c"]);

    expect(dismissWorkflowRunIds([])).toBe(0);
    expect(dismissWorkflowRunIds(["d-a"])).toBe(0);
  });

  it("a corrupt store reads as empty and the next dismiss rewrites it whole", () => {
    mkdirSync(path.dirname(storeFile()), { recursive: true });
    writeFileSync(storeFile(), "{not json");

    expect(dismissedRunIds().has("d-x")).toBe(false);
    expect(dismissWorkflowRunIds(["d-x"])).toBe(1);
    const raw = JSON.parse(readFileSync(storeFile(), "utf8")) as Record<string, number>;
    expect(raw["d-x"]).toEqual(expect.any(Number));
  });

  it("prunes year-old entries at write", () => {
    mkdirSync(path.dirname(storeFile()), { recursive: true });
    const ancient = Date.now() - 400 * 24 * 60 * 60 * 1000;
    writeFileSync(storeFile(), JSON.stringify({ "d-ancient": ancient, "d-kept": Date.now() }));

    expect(dismissWorkflowRunIds(["d-new"])).toBe(1);
    const ids = dismissedRunIds();
    expect(ids.has("d-ancient")).toBe(false);
    expect(ids.has("d-kept")).toBe(true);
    expect(ids.has("d-new")).toBe(true);
  });
});
