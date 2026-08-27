/**
 * Tests for the REPL turn state machine (src/repl/model.ts) and the code
 * fence colorizer (src/repl/App.tsx).
 *
 * The state machine folds raw ACP SessionUpdate notifications into render
 * entries; these tests lock the chunk-ordering rules (thought flush on first
 * message chunk, tool row upsert by toolCallId, stop-reason note) that the
 * Ink view relies on.
 */

import { describe, expect, it } from "vitest";

import { colorizeCodeFences } from "../src/repl/App.js";
import {
  applyCompletion,
  applyStatusUpdate,
  applyUpdate,
  completionCandidates,
  createReplStatus,
  createTurnState,
  finishTurn,
  formatConfigList,
  formatQuotaLine,
  handleLocalCommand,
  isConfigArgumentMenu,
  isOneShotCommandValue,
  parseCommand,
  relativeTime,
  parseQuestionForm,
  selectLabel,
  seedStatusFromNewSession,
  type SessionUpdateLike,
} from "../src/repl/model.js";

function chunk(
  kind: "agent_message_chunk" | "agent_thought_chunk",
  text: string,
): SessionUpdateLike {
  return { sessionUpdate: kind, content: { type: "text", text } } as SessionUpdateLike;
}

describe("applyUpdate", () => {
  it("buffers thought and message chunks separately", () => {
    let s = createTurnState();
    s = applyUpdate(s, chunk("agent_thought_chunk", "thinking…"));
    expect(s.thinkBuf).toBe("thinking…");
    expect(s.textBuf).toBe("");
    // A second thought chunk keeps accumulating before any prose starts.
    s = applyUpdate(s, chunk("agent_thought_chunk", " more"));
    expect(s.thinkBuf).toBe("thinking… more");
  });

  it("flushes the thought buffer as an entry when prose starts", () => {
    let s = createTurnState();
    s = applyUpdate(s, chunk("agent_thought_chunk", "plan the answer"));
    s = applyUpdate(s, chunk("agent_message_chunk", "Here it is"));
    expect(s.entries).toEqual([{ kind: "thinking", text: "plan the answer" }]);
    expect(s.thinkBuf).toBe("");
  });

  it("upserts tool rows by toolCallId and keeps last status", () => {
    let s = createTurnState();
    s = applyUpdate(s, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Read README.md",
      status: "in_progress",
    } as SessionUpdateLike);
    s = applyUpdate(s, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
    } as SessionUpdateLike);
    expect(s.entries).toEqual([
      { kind: "tool", id: "t1", title: "Read README.md", status: "completed" },
    ]);
  });

  it("renders a tool_call_update for an unseen call as a fresh row", () => {
    const s = applyUpdate(createTurnState(), {
      sessionUpdate: "tool_call_update",
      toolCallId: "late",
      title: "Late call",
      status: "completed",
    } as SessionUpdateLike);
    expect(s.entries).toEqual([
      { kind: "tool", id: "late", title: "Late call", status: "completed" },
    ]);
  });
});

describe("finishTurn", () => {
  it("flushes pending buffers and only notes non-end_turn stops", () => {
    let s = createTurnState();
    s = applyUpdate(s, chunk("agent_thought_chunk", "hmm"));
    s = applyUpdate(s, chunk("agent_message_chunk", "answer"));
    const entries = finishTurn(s, "end_turn");
    expect(entries).toEqual([
      { kind: "thinking", text: "hmm" },
      { kind: "assistant", text: "answer" },
    ]);
  });

  it("adds a stopped note for cancelled turns", () => {
    const entries = finishTurn(createTurnState(), "cancelled");
    expect(entries).toEqual([{ kind: "note", text: "stopped: cancelled" }]);
  });
});

describe("parseCommand", () => {
  it("recognizes exit aliases and treats everything else as a prompt", () => {
    expect(parseCommand("/exit")).toBe("exit");
    expect(parseCommand("/quit")).toBe("exit");
    expect(parseCommand("/q")).toBe("exit");
    expect(parseCommand("fix the bug")).toBe(null);
    expect(parseCommand("")).toBe(null);
  });

  it("recognizes the sessions picker command", () => {
    expect(parseCommand("/sessions")).toBe("sessions");
    expect(parseCommand(" /sessions ")).toBe("sessions");
    expect(parseCommand("/session")).toBe(null);
    expect(parseCommand("/sessions now")).toBe(null);
  });
});

describe("relativeTime", () => {
  it("renders compact ages for recent timestamps", () => {
    const now = Date.now();
    const iso = (msAgo: number): string => new Date(now - msAgo).toISOString();
    expect(relativeTime(iso(5_000))).toBe("just now");
    expect(relativeTime(iso(5 * 60_000))).toBe("5m ago");
    expect(relativeTime(iso(3 * 3_600_000))).toBe("3h ago");
    expect(relativeTime(iso(2 * 86_400_000))).toBe("2d ago");
  });

  it("falls back to the date and tolerates missing input", () => {
    expect(relativeTime(null)).toBe("");
    expect(relativeTime(undefined)).toBe("");
    expect(relativeTime("not-a-date")).toBe("");
    expect(relativeTime("2024-01-15T10:00:00.000Z")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("applyStatusUpdate", () => {
  it("folds the command menu from available_commands_update", () => {
    const next = applyStatusUpdate(createReplStatus(), {
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "model", description: "switch model" },
        { name: "quota", description: "" },
      ],
    } as SessionUpdateLike);
    expect(next.commands).toEqual([
      { name: "model", description: "switch model" },
      { name: "quota", description: "" },
    ]);
  });

  it("folds select configs from config_option_update", () => {
    const next = applyStatusUpdate(createReplStatus(), {
      sessionUpdate: "config_option_update",
      configOptions: [
        {
          id: "model",
          type: "select",
          currentValue: "GLM-5.3",
          options: [
            { value: "GLM-5.3", name: "GLM-5.3" },
            { value: "uuid\\gpt-x", name: "Acme › gpt-x" },
          ],
        },
        {
          id: "mode",
          type: "select",
          currentValue: "build",
          options: [{ value: "build", name: "build" }],
        },
      ],
    } as SessionUpdateLike);
    expect(next.model).toEqual({
      current: "GLM-5.3",
      options: [
        { value: "GLM-5.3", name: "GLM-5.3" },
        { value: "uuid\\gpt-x", name: "Acme › gpt-x" },
      ],
    });
    expect(next.mode?.current).toBe("build");
  });

  it("updates the current mode from current_mode_update", () => {
    let status = createReplStatus();
    status = applyStatusUpdate(status, {
      sessionUpdate: "current_mode_update",
      currentModeId: "plan",
    } as SessionUpdateLike);
    expect(status.mode).toEqual({ current: "plan", options: [] });
  });

  it("returns the same reference for unknown update kinds", () => {
    const status = createReplStatus();
    expect(
      applyStatusUpdate(status, { sessionUpdate: "user_message_chunk" } as SessionUpdateLike),
    ).toBe(status);
  });

  it("seeds config selects from the session/new response body", () => {
    // The initial config rides the response, not a notification — a fresh
    // pending session defaults to the yolo mode per buildConfigOptions.
    const status = seedStatusFromNewSession(createReplStatus(), {
      configOptions: [
        {
          id: "mode",
          type: "select",
          currentValue: "yolo",
          options: [
            { value: "plan", name: "plan" },
            { value: "yolo", name: "yolo" },
          ],
        },
      ],
    });
    expect(status.mode).toEqual({
      current: "yolo",
      options: [
        { value: "plan", name: "plan" },
        { value: "yolo", name: "yolo" },
      ],
    });
  });
});

describe("formatConfigList / selectLabel", () => {
  const select = {
    current: "GLM-5.3",
    options: [
      { value: "GLM-5.3", name: "GLM-5.3" },
      { value: "uuid\\gpt-x", name: "Acme › gpt-x" },
    ],
  };

  it("marks the current option and hints values that differ from names", () => {
    const lines = formatConfigList("/model", select);
    expect(lines[0]).toBe("/model:");
    expect(lines[1]).toBe("● GLM-5.3");
    expect(lines[2]).toBe("  Acme › gpt-x  (uuid\\gpt-x)");
  });

  it("falls back to a hint line when nothing is advertised", () => {
    expect(formatConfigList("/model", null)).toEqual(["/model: no options advertised yet"]);
  });

  it("prefers the option name over the raw value for the status line", () => {
    expect(selectLabel(select)).toBe("GLM-5.3");
    expect(selectLabel({ current: "unknown", options: select.options })).toBe("unknown");
    expect(selectLabel(null)).toBe("");
  });
});

describe("handleLocalCommand", () => {
  it("lists options for the arg-less forms of /model /mode /thought", () => {
    const status = createReplStatus();
    status.model = { current: "GLM-5.3", options: [{ value: "GLM-5.3", name: "GLM-5.3" }] };
    const out = handleLocalCommand("/model", status);
    expect(out).not.toBeNull();
    expect(out![0]).toEqual({ kind: "note", text: "/model:" });
    expect(out![1]).toEqual({ kind: "note", text: "● GLM-5.3" });
  });

  it("passes the switch forms (with an argument) through as prompts", () => {
    expect(handleLocalCommand("/model GLM-5.3", createReplStatus())).toBeNull();
    expect(handleLocalCommand("/mode yolo", createReplStatus())).toBeNull();
    expect(handleLocalCommand("/thought max", createReplStatus())).toBeNull();
  });

  it("renders /help from the bridge menu or the fallback list", () => {
    const withMenu = createReplStatus();
    withMenu.commands = [{ name: "compact", description: "compact context" }];
    const fromMenu = handleLocalCommand("/help", withMenu)!;
    expect(
      fromMenu.some((e) => e.kind === "note" && e.text.includes("/compact — compact context")),
    ).toBe(true);
    const fromFallback = handleLocalCommand("/help", createReplStatus())!;
    expect(fromFallback.some((e) => e.kind === "note" && e.text.includes("/model —"))).toBe(true);
  });

  it("leaves plain prompts and unknown commands to the passthrough path", () => {
    expect(handleLocalCommand("fix the bug", createReplStatus())).toBeNull();
    expect(handleLocalCommand("/compact", createReplStatus())).toBeNull();
  });
});

describe("isConfigArgumentMenu", () => {
  it("is true only while typing a config command's argument", () => {
    expect(isConfigArgumentMenu("/model ")).toBe(true);
    expect(isConfigArgumentMenu("/model glm")).toBe(true);
    expect(isConfigArgumentMenu("/MODE p")).toBe(true); // case-insensitive command
    expect(isConfigArgumentMenu("/thought max")).toBe(true);
  });

  it("is false for command-name menus and non-slash text", () => {
    expect(isConfigArgumentMenu("/model")).toBe(false);
    expect(isConfigArgumentMenu("/sessions proj")).toBe(false);
    expect(isConfigArgumentMenu("/skill-x arg")).toBe(false);
    expect(isConfigArgumentMenu("model v")).toBe(false);
    expect(isConfigArgumentMenu("")).toBe(false);
  });
});

describe("isOneShotCommandValue", () => {
  it("marks argument-free commands that run on pick", () => {
    expect(isOneShotCommandValue("/exit")).toBe(true);
    expect(isOneShotCommandValue("/HELP")).toBe(true); // case-insensitive command
    expect(isOneShotCommandValue("/sessions")).toBe(true);
    expect(isOneShotCommandValue("/compact")).toBe(true);
  });

  it("leaves config, skills, arguments and plain text as fill-then-confirm", () => {
    expect(isOneShotCommandValue("/model")).toBe(false); // opens its option menu
    expect(isOneShotCommandValue("/skill-x")).toBe(false);
    expect(isOneShotCommandValue("/mcp extra")).toBe(false); // carries an argument
    expect(isOneShotCommandValue("exit")).toBe(false); // no slash
    expect(isOneShotCommandValue("")).toBe(false);
  });
});

describe("completionCandidates / applyCompletion", () => {
  const status = createReplStatus();
  status.model = {
    current: "GLM-5.3",
    options: [
      { value: "GLM-5.3", name: "GLM-5.3" },
      { value: "uuid\\gpt-x", name: "Acme › gpt-x" },
    ],
  };
  status.mode = {
    current: "yolo",
    options: [{ value: "plan", name: "plan" }],
  };

  it("offers every fallback command for a bare slash", () => {
    const out = completionCandidates("/", status)!;
    expect(out.length).toBeGreaterThan(4);
    // Locals absent from the fallback list (e.g. /sessions) lead the merge.
    expect(out[0]).toMatchObject({ value: "/sessions", label: "/sessions" });
    expect(out.map((c) => c.value)).toContain("/help");
  });

  it("filters command names by prefix, case-insensitively", () => {
    const out = completionCandidates("/MO", status)!;
    expect(out.map((c) => c.value)).toEqual(["/model", "/mode"]);
  });

  it("returns an empty list (not null) for a non-matching command prefix", () => {
    expect(completionCandidates("/zzz", status)).toEqual([]);
  });

  it("lists option values after a config command and its space", () => {
    const out = completionCandidates("/model ", status)!;
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ value: "GLM-5.3", current: true });
    expect(out[1]).toMatchObject({ value: "uuid\\gpt-x", description: "uuid\\gpt-x" });
  });

  it("filters options by value AND by display name", () => {
    expect(completionCandidates("/model uuid", status)!.map((c) => c.value)).toEqual([
      "uuid\\gpt-x",
    ]);
    expect(completionCandidates("/model acme", status)!.map((c) => c.value)).toEqual([
      "uuid\\gpt-x",
    ]);
    expect(completionCandidates("/mode p", status)!.map((c) => c.value)).toEqual(["plan"]);
  });

  it("stays out of the way outside completion contexts", () => {
    expect(completionCandidates("plain prompt", status)).toBeNull();
    expect(completionCandidates("/compact ", status)).toBeNull(); // not a config command
    expect(completionCandidates("/model a b", status)).toBeNull(); // past the single arg
    expect(completionCandidates("/thought ", status)).toBeNull(); // select not advertised
  });

  it("keeps REPL-local commands in the menu once the bridge advertises its own", () => {
    const withBridge = createReplStatus();
    withBridge.commands = [
      { name: "compact", description: "Compress conversation context" },
      { name: "model", description: "Switch the session model" },
    ];
    const out = completionCandidates("/", withBridge)!;
    // Local help/sessions/exit lead even though the bridge doesn't advertise them.
    expect(out.map((c) => c.value)).toEqual(["/help", "/sessions", "/exit", "/compact", "/model"]);
    // /help output uses the same merged menu.
    const help = handleLocalCommand("/help", withBridge)!;
    expect(help.some((e) => e.kind === "note" && e.text.includes("/help —"))).toBe(true);
    expect(help.some((e) => e.kind === "note" && e.text.includes("/compact —"))).toBe(true);
  });

  it("completes commands with a trailing space and options in place", () => {
    expect(applyCompletion("/mod", { value: "/model", label: "/model" })).toBe("/model ");
    expect(applyCompletion("/model gl", { value: "GLM-5.3", label: "GLM-5.3" })).toBe(
      "/model GLM-5.3",
    );
    expect(applyCompletion("/model ", { value: "uuid\\gpt-x", label: "x" })).toBe(
      "/model uuid\\gpt-x",
    );
  });
});

describe("colorizeCodeFences", () => {
  it("leaves plain prose untouched and marks fenced lines", () => {
    const out = colorizeCodeFences("intro\n```ts\nconst x = 1;\n```\nafter");
    // ANSI codes wrap the fenced region; plain lines stay identical.
    expect(out).toContain("intro");
    expect(out).toContain("after");
    expect(out).toMatch(/const x = 1;/);
    // The fence content is colorized (an ANSI escape sequence directly
    // precedes it); avoid a literal escape in the regex to satisfy lint.
    const idx = out.indexOf("const x = 1;");
    const esc = String.fromCharCode(27);
    expect(out.slice(idx - 6, idx)).toContain(esc + "[");
  });
});

describe("parseQuestionForm", () => {
  const form = (props: Record<string, unknown>) => ({
    mode: "form",
    sessionId: "s1",
    message: "Please answer the question.",
    requestedSchema: { type: "object", properties: props, required: [] },
  });

  it("parses single-select oneOf questions and drops the skip sentinel", () => {
    const out = parseQuestionForm(
      form({
        q_0: {
          type: "string",
          title: "Which language?",
          oneOf: [
            { const: "Rust", title: "Rust" },
            { const: "Go", title: "Go" },
            { const: "__skip__", title: "Skip this question" },
          ],
        },
        q_0_other: { type: "string", title: "↳ or type a custom value" },
      }),
    )!;
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: "q_0", title: "Which language?", multiSelect: false });
    expect(out[0]!.options).toEqual([
      { value: "Rust", label: "Rust" },
      { value: "Go", label: "Go" },
    ]);
  });

  it("parses multi-select array questions with anyOf items", () => {
    const out = parseQuestionForm(
      form({
        q_0: {
          type: "array",
          title: "Pick toppings",
          items: {
            anyOf: [
              { const: "a", title: "Anchovies" },
              { const: "m", title: "Mushrooms" },
            ],
          },
        },
      }),
    )!;
    expect(out[0]).toMatchObject({ key: "q_0", multiSelect: true });
    expect(out[0]!.options[0]).toEqual({ value: "a", label: "Anchovies" });
  });

  it("orders questions numerically and rejects unusable payloads", () => {
    const out = parseQuestionForm(
      form({
        q_1: { type: "string", title: "Second?", oneOf: [{ const: "y" }] },
        q_0: { type: "string", title: "First?", oneOf: [{ const: "x" }] },
      }),
    )!;
    expect(out.map((f) => f.key)).toEqual(["q_0", "q_1"]);
    expect(parseQuestionForm(null)).toBeNull();
    expect(parseQuestionForm({ mode: "url" })).toBeNull();
    expect(parseQuestionForm(form({ q_0: { type: "string", title: "No options" } }))).toBeNull();
  });
});

describe("formatQuotaLine", () => {
  const ok = (items: Array<{ key: string; label: string; usedPercent: number }>) => ({
    kind: "success" as const,
    level: "pro",
    items,
  });

  it("summarizes token windows compactly and rounds percents", () => {
    expect(
      formatQuotaLine(
        ok([
          { key: "token_5h", label: "5h", usedPercent: 33.7 },
          { key: "mcp", label: "MCP", usedPercent: 12 },
          { key: "token_week", label: "Week", usedPercent: 8.2 },
        ]),
      ),
    ).toBe("5h 34% · wk 8%");
  });

  it("skips unknown future windows and empty item lists", () => {
    expect(formatQuotaLine(ok([{ key: "token_30", label: "30", usedPercent: 1 }]))).toBeNull();
    expect(formatQuotaLine(ok([]))).toBeNull();
  });

  it("returns null for non-success results and null input", () => {
    expect(formatQuotaLine({ kind: "auth_error" })).toBeNull();
    expect(formatQuotaLine({ kind: "unavailable" })).toBeNull();
    expect(formatQuotaLine(null)).toBeNull();
  });
});
