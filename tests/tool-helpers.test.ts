/**
 * Unit tests for tool-helpers: pure functions that render tool output, build
 * diff content, extract exit codes and locations.
 */

import { describe, expect, it } from "vitest";

import {
  buildDiffContent,
  extractLocations,
  parseSubagentMetadata,
} from "../src/translators/tool-helpers.js";

describe("buildDiffContent", () => {
  it("builds a diff content block from +/- lines", () => {
    const out = buildDiffContent({
      kind: "file_diff",
      filePath: "src/a.ts",
      structuredPatch: [{ newStart: 10, lines: [" ctx", "-old", "+new"] }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "diff",
      path: "src/a.ts",
      oldText: "ctx\nold",
      newText: "ctx\nnew",
    });
  });
});

describe("extractLocations", () => {
  it("prefers file_diff display hunks (Edit/Write)", () => {
    const locs = extractLocations(
      "Edit",
      {},
      {
        kind: "file_diff",
        filePath: "src/a.ts",
        structuredPatch: [{ newStart: 10 }, { newStart: 25 }],
      },
    );
    expect(locs).toEqual([
      { path: "src/a.ts", line: 10 },
      { path: "src/a.ts", line: 25 },
    ]);
  });
});

describe("parseSubagentMetadata", () => {
  it("parses agentId and usage from a synchronous sub-agent result string", () => {
    const content =
      "The deps are minimal...\nagentId: agent_73c7c63d-94e9-4c1f-9855-da189151c323 (use SendMessage ...)\n<usage>subagent_tokens: 40904\ntool_uses: 1\nduration_ms: 10559</usage>";
    const meta = parseSubagentMetadata(content);
    expect(meta).not.toBeNull();
    expect(meta!.agentId).toBe("agent_73c7c63d-94e9-4c1f-9855-da189151c323");
    expect(meta!.tokens).toBe(40904);
    expect(meta!.toolUses).toBe(1);
    expect(meta!.durationMs).toBe(10559);
    expect(meta!.background).toBeUndefined();
  });
});
