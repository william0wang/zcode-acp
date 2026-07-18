/**
 * Tool translation helpers: kind mapping, input summary, result-content
 * shaping, diff parsing, location extraction, exit-code extraction, error
 * rendering.
 *
 * These are pure functions shared by `EventTranslator` (event-stream path) and
 * `ProjectionDiffer` (snapshot path) so both render the same titles/content for
 * the same tool.
 */

import type { ToolCallContent, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";

/** zcode toolName → ACP ToolKind. Keys are case-duplicated for safety. */
export const TOOL_KIND_MAP: Record<string, ToolKind> = {
  Bash: "execute",
  bash: "execute",
  Edit: "edit",
  Write: "edit",
  edit: "edit",
  write: "edit",
  Read: "read",
  read: "read",
  Grep: "search",
  grep: "search",
  Glob: "search",
  WebFetch: "fetch",
  WebSearch: "fetch",
  web_search: "fetch",
  // Sub-agent dispatch (zcode toolName="Agent", not Task). Deliberately NOT
  // "execute" so the editor shows a generic call card rather than a shell.
  Agent: "other",
  Task: "other",
};

/** Max length for single-field title summaries (not Bash command — kept full). */
const SUMMARY_MAX = 60;
/** Max length for rendered result output. */
const OUTPUT_MAX = 2000;

/**
 * Extract a one-line summary from a tool's input object (used for the ACP
 * ToolCall `title`). Priority: command / description / query / file_path /
 * path / pattern / prompt. Bash `command` is NOT truncated (Zed's terminal
 * card needs the full command); other fields truncate to SUMMARY_MAX. Falls
 * back to compact JSON, then String(input). Returns "" for empty input.
 */
export function summarizeToolInput(_toolName: string, inp: unknown): string {
  if (inp == null) return "";
  if (typeof inp === "object" && !Array.isArray(inp)) {
    const obj = inp as Record<string, unknown>;
    for (const k of ["command", "description", "query", "file_path", "path", "pattern", "prompt"]) {
      const v = obj[k];
      if (v) {
        // Bash command: full (matches reference impl; Zed terminal card needs full command).
        if (k === "command") return String(v);
        return String(v).slice(0, SUMMARY_MAX);
      }
    }
    try {
      return JSON.stringify(obj).slice(0, SUMMARY_MAX);
    } catch {
      return String(inp).slice(0, SUMMARY_MAX);
    }
  }
  return String(inp).slice(0, SUMMARY_MAX);
}

/**
 * Render a tool result/progress output into a readable string. The zcode
 * standard result structure is `{success, content, perf:{...}}`; the `content`
 * field is the actual command output the user cares about. On `success:false`
 * with empty content, prefix the error/message. Other shapes fall back to JSON.
 */
export function renderToolOutput(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output.slice(0, OUTPUT_MAX);
  if (typeof output === "object") {
    if (!Array.isArray(output)) {
      const obj = output as Record<string, unknown>;
      const content = obj["content"];
      if (typeof content === "string" && content) return content.slice(0, OUTPUT_MAX);
      if (obj["success"] === false) {
        const err = String(obj["error"] ?? obj["message"] ?? "");
        if (err) return `[failed] ${err.slice(0, OUTPUT_MAX)}`;
      }
      try {
        return JSON.stringify(obj).slice(0, OUTPUT_MAX);
      } catch {
        return String(output).slice(0, OUTPUT_MAX);
      }
    }
    try {
      return JSON.stringify(output).slice(0, OUTPUT_MAX);
    } catch {
      return String(output).slice(0, OUTPUT_MAX);
    }
  }
  return String(output).slice(0, OUTPUT_MAX);
}

/**
 * Extract a Bash exit code from a result payload. Reads `perf.exitCode`
 * (integer); falls back to inferring 1 on `success:false`, else 0. For error
 * payloads with no usable dict, returns 1 when `isError`.
 */
export function extractExitCode(resultPayload: unknown, isError = false): number {
  if (resultPayload && typeof resultPayload === "object" && !Array.isArray(resultPayload)) {
    const obj = resultPayload as Record<string, unknown>;
    const perf = obj["perf"] as Record<string, unknown> | undefined;
    if (perf && typeof perf["exitCode"] === "number") {
      return perf["exitCode"] as number;
    }
    if (obj["success"] === false) return 1;
    return 0;
  }
  if (isError) return 1;
  return 0;
}

/**
 * Build ACP `ToolCallContent[]` (type:"content") from a result, for display in
 * the editor's tool card. Error → code fence; Read → plain text; Bash →
 * `console` code block; default → plain text. Returns [] when there's no text
 * (caller skips to avoid clobbering rawOutput).
 *
 * Edit/Write are NOT handled here — their diff is dispatched separately from
 * `session/messages` metadata (more timely and reliable).
 */
export function buildResultContent(
  toolName: string,
  resultPayload: unknown,
  isError = false,
): ToolCallContent[] {
  let text = "";
  if (resultPayload && typeof resultPayload === "object" && !Array.isArray(resultPayload)) {
    const obj = resultPayload as Record<string, unknown>;
    const c = obj["content"];
    if (typeof c === "string" && c) {
      text = c;
    } else if (obj["success"] === false) {
      text = String(obj["error"] ?? obj["message"] ?? "");
    } else if (c == null) {
      try {
        text = JSON.stringify(obj);
      } catch {
        text = String(resultPayload);
      }
    }
  } else if (typeof resultPayload === "string") {
    text = resultPayload;
  } else if (resultPayload != null) {
    try {
      text = JSON.stringify(resultPayload);
    } catch {
      text = String(resultPayload);
    }
  }

  if (!text || !text.trim()) return [];
  text = text.slice(0, OUTPUT_MAX);

  if (isError) {
    return [{ type: "content", content: { type: "text", text: "```\n" + text + "\n```" } }];
  }
  if (toolName === "Read" || toolName === "read") {
    return [{ type: "content", content: { type: "text", text } }];
  }
  if (toolName === "Bash" || toolName === "bash") {
    return [
      {
        type: "content",
        content: { type: "text", text: "```console\n" + text.trimEnd() + "\n```" },
      },
    ];
  }
  return [{ type: "content", content: { type: "text", text } }];
}

interface StructuredPatchHunk {
  oldStart?: number;
  oldLines?: number;
  newStart?: number;
  newLines?: number;
  lines?: string[];
}

interface FileDiffDisplay {
  kind?: string;
  filePath?: string;
  structuredPatch?: StructuredPatchHunk[];
}

/**
 * Build ACP `ToolCallContent[]` with the "diff" variant from a tool part's
 * `metadata.display` (kind:"file_diff"). Each hunk → one
 * `{type:"diff", path, oldText, newText}` where the texts are the old/new
 * line sets (not unified-diff strings). Empty `oldText` → null (new-file
 * convention). Returns [] when display isn't a file_diff or has no patches.
 */
export function buildDiffContent(display: unknown): ToolCallContent[] {
  if (!display || typeof display !== "object" || Array.isArray(display)) return [];
  const d = display as FileDiffDisplay;
  if (d.kind !== "file_diff") return [];
  const filePath = d.filePath ?? "";
  const patches = d.structuredPatch ?? [];
  if (!filePath || patches.length === 0) return [];

  const content: ToolCallContent[] = [];
  for (const hunk of patches) {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (const hl of hunk.lines ?? []) {
      if (typeof hl !== "string") continue;
      if (hl.startsWith("-")) {
        oldLines.push(hl.slice(1));
      } else if (hl.startsWith("+")) {
        newLines.push(hl.slice(1));
      } else {
        // Context line (leading " " or no prefix) → both sides.
        const ctx = hl.startsWith(" ") ? hl.slice(1) : hl;
        oldLines.push(ctx);
        newLines.push(ctx);
      }
    }
    if (oldLines.length > 0 || newLines.length > 0) {
      content.push({
        type: "diff",
        path: filePath,
        oldText: oldLines.length > 0 ? oldLines.join("\n") : null,
        newText: newLines.join("\n"),
      });
    }
  }
  return content;
}

/**
 * Extract ACP `ToolCallLocation[]` ({path, line?}) for deep-linking. Edit/Write
 * completion prefers the diff display's `newStart` (precise change line); other
 * tools derive from input (Read → file_path+offset, Glob/Grep → search dir).
 */
export function extractLocations(
  toolName: string,
  inp: unknown,
  display?: unknown,
): ToolCallLocation[] {
  // 1. Edit/Write completion: prefer diff display's filePath + newStart.
  if (display && typeof display === "object" && !Array.isArray(display)) {
    const d = display as FileDiffDisplay;
    if (d.kind === "file_diff") {
      const fp = d.filePath ?? "";
      const patches = d.structuredPatch ?? [];
      if (fp && patches.length > 0) {
        const locs: ToolCallLocation[] = [];
        for (const hunk of patches) {
          if (typeof hunk.newStart === "number") {
            locs.push({ path: fp, line: hunk.newStart });
          }
        }
        return locs.length > 0 ? locs : fp ? [{ path: fp }] : [];
      }
    }
  }

  // 2. Derive from input by tool type.
  if (!inp || typeof inp !== "object" || Array.isArray(inp)) return [];
  const obj = inp as Record<string, unknown>;
  if (toolName === "Read" || toolName === "read") {
    const fp = String(obj["file_path"] ?? obj["path"] ?? "");
    if (fp) {
      const offset = obj["offset"];
      return [{ path: fp, line: typeof offset === "number" ? offset : 1 }];
    }
  } else if (
    toolName === "Write" ||
    toolName === "write" ||
    toolName === "Edit" ||
    toolName === "edit"
  ) {
    const fp = String(obj["file_path"] ?? obj["path"] ?? "");
    if (fp) return [{ path: fp }];
  } else if (
    toolName === "Glob" ||
    toolName === "glob" ||
    toolName === "Grep" ||
    toolName === "grep"
  ) {
    const p = String(obj["path"] ?? obj["file_path"] ?? "");
    if (p) return [{ path: p }];
  }
  return [];
}

/**
 * Structured sub-agent metadata extracted from an Agent/Task tool result's
 * content. The zcode backend appends these as plain-text markers at the end of
 * the result content (e.g. `agentId: agent_xxx (use SendMessage ...)` and
 * `<usage>subagent_tokens: 40904\ntool_uses: 1\nduration_ms: 10559</usage>`).
 * Editors can use the parsed fields to badge the tool card; the raw content is
 * left intact for the user-facing text.
 */
export interface SubagentMetadata {
  agentId?: string;
  background?: boolean;
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
}

const AGENT_ID_RE = /agentId:\s*(agent_[A-Za-z0-9-]+)/;
// <usage>subagent_tokens: 40904\ntool_uses: 1\nduration_ms: 10559</usage>
const USAGE_RE =
  /<usage>\s*subagent_tokens:\s*(\d+)\s*tool_uses:\s*(\d+)\s*duration_ms:\s*(\d+)\s*<\/usage>/;
const BACKGROUND_RE = /\b(background(ed)?|async_launched|backgroundTaskId)\b/i;

/**
 * Parse sub-agent metadata markers from an Agent/Task result content string.
 * Returns null when no sub-agent markers are present (so non-Agent results
 * short-circuit cheaply). The content may be a JSON string (the backend wraps
 * the result) or plain text — both shapes are handled.
 */
export function parseSubagentMetadata(rawContent: unknown): SubagentMetadata | null {
  let text: string;
  if (typeof rawContent === "string") {
    text = rawContent;
  } else if (rawContent && typeof rawContent === "object" && !Array.isArray(rawContent)) {
    const c = (rawContent as Record<string, unknown>)["content"];
    if (typeof c !== "string") return null;
    text = c;
  } else {
    return null;
  }
  if (!text.includes("agentId:") && !text.includes("<usage>")) return null;

  const meta: SubagentMetadata = {};
  const aid = text.match(AGENT_ID_RE);
  if (aid) meta.agentId = aid[1];
  const usage = text.match(USAGE_RE);
  if (usage) {
    meta.tokens = Number(usage[1]);
    meta.toolUses = Number(usage[2]);
    meta.durationMs = Number(usage[3]);
  }
  if (BACKGROUND_RE.test(text)) meta.background = true;
  // Require at least one recognised field, else treat as non-subagent.
  if (meta.agentId === undefined && meta.tokens === undefined) return null;
  return meta;
}

/** Render a turn.failed error object into a readable single-line string. */
export function formatTurnError(error: unknown): string {
  if (!error || typeof error !== "object" || Array.isArray(error)) return "";
  const e = error as Record<string, unknown>;
  const code = String(e["code"] ?? "").trim();
  const message = String(e["message"] ?? "").trim();
  const detail = String(e["detail"] ?? "").trim();
  const etype = String(e["type"] ?? "").trim();

  const parts: string[] = [];
  if (code) parts.push(code);
  if (message) parts.push(message);
  if (parts.length === 0 && etype) parts.push(etype);
  let out = parts.join(" ");

  if (detail) {
    const firstDetail = detail.split("\n")[0]?.trim() ?? "";
    if (firstDetail && !out.includes(firstDetail)) {
      const trimmed = firstDetail.length > 160 ? firstDetail.slice(0, 160) + "..." : firstDetail;
      out = out ? `${out} (${trimmed})` : trimmed;
    }
  }
  return out;
}
