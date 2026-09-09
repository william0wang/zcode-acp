/**
 * Vendored prompt templates for the goal loop (ADR-0022).
 *
 * These distill the format conventions of the Matt Pocock workflow skills
 * (to-tickets ticket shape, shift dispatch/VERDICT contracts, handoff rules)
 * but are FROZEN COPIES: the source skills are `disable-model-invocation` and
 * user-editable — reading them at runtime would let a user's local edits
 * change loop behavior. Do not "restore" live skill reads.
 */

import type { GoalTicket } from "./state.js";

/** Decompose the objective into vertical-slice tickets (round 0, uncounted). */
export function decomposePrompt(objective: string): string {
  return [
    `# Objective`,
    objective,
    ``,
    `Decompose this objective into 1-5 vertical-slice tickets. A vertical slice`,
    `is a thin end-to-end increment that can be verified on its own — prefer`,
    `"smallest thing that works end to end" over horizontal layers.`,
    ``,
    `Reply with ONLY a fenced block, one ticket per line:`,
    "```",
    `- [title] | [how to verify it is done, concretely — commands to run, files to check]`,
    "```",
    ``,
    `No prose outside the block.`,
  ].join("\n");
}

/** Parse the decompose reply; null when no ticket lines parse out. */
export function parseTickets(reply: string): Array<{ title: string; acceptance: string }> | null {
  const lines = reply
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "));
  const out: Array<{ title: string; acceptance: string }> = [];
  for (const line of lines) {
    const body = line.slice(2);
    const sep = body.indexOf("|");
    const title = (sep === -1 ? body : body.slice(0, sep)).trim();
    const acceptance = sep === -1 ? title : body.slice(sep + 1).trim();
    if (title) out.push({ title, acceptance });
  }
  return out.length > 0 ? out : null;
}

/**
 * One-ticket dispatch prompt: objective restated (durable state re-injection),
 * the current ticket in full, hard boundaries, verdict contract, and — when
 * present — handoff read-back instruction and merged user steer text.
 */
export function dispatchPrompt(opts: {
  objective: string;
  ticket: GoalTicket;
  ticketIndex: number;
  ticketCount: number;
  handoffFile?: string;
  userText?: string;
}): string {
  const { objective, ticket, handoffFile, userText } = opts;
  const lines: string[] = [
    `# Goal loop dispatch (ticket ${opts.ticketIndex}/${opts.ticketCount})`,
    ``,
    `## Objective (unchanged across rounds)`,
    objective,
    ``,
    `## Your ticket for THIS round — work on exactly this, nothing else`,
    `- ${ticket.title}`,
    `- Acceptance: ${ticket.acceptance}`,
  ];
  if (ticket.feedback) {
    lines.push(`- Previous verification FAILED with: ${ticket.feedback}`);
  }
  if (handoffFile) {
    lines.push(
      ``,
      `## Context was compacted since the last round`,
      `Read ${handoffFile} FIRST (use the Read tool) — it is the handoff from your`,
      `previous rounds. Treat it as your memory of prior progress; do not rely on`,
      `remembering anything not in it or in this prompt.`,
    );
  }
  if (userText) {
    lines.push(``, `## User message (steering this round)`, userText);
  }
  lines.push(
    ``,
    `## Rules`,
    `- Inspect the real current state before acting; do not rely on memory.`,
    `- Stay inside the scope of this ticket and the project directory.`,
    `- Verify your own work (run the acceptance check) before claiming done.`,
    ``,
    `## Return format (mandatory, last line of your reply)`,
    `VERDICT: met | not-yet | impossible`,
    `If not-yet: one short GAPS: line listing what remains.`,
    `If impossible: one short WHY: line.`,
  );
  return lines.join("\n");
}

/**
 * Verification turn: re-run acceptance criteria, never trust the report. The
 * verdict is WRITTEN TO A FILE in a fixed format (far more reliable than
 * parsing a prose reply — observed 2026-09: verbose replies never matched the
 * bare-keyword contract and looped forever); the reply text is only a fallback.
 */
export function verifyPrompt(ticket: GoalTicket, verifyFile: string): string {
  return [
    `# Goal loop verification`,
    `The worker claims this ticket is complete:`,
    `- ${ticket.title}`,
    `- Acceptance: ${ticket.acceptance}`,
    ``,
    `Re-run the acceptance criteria YOURSELF (execute the checks, read the files`,
    `or diffs — do not trust the worker's summary or any transcript claims).`,
    ``,
    `Then write your verdict with the Write tool to EXACTLY this path:`,
    verifyFile,
    ``,
    `The file content must be EXACTLY one line, nothing else:`,
    `PASS`,
    `or`,
    `FAIL: <what specifically did not hold>`,
    ``,
    `Reply with only: DONE`,
  ].join("\n");
}

/**
 * Strict retry for an unreadable verification result: the verdict file was
 * missing or unparseable. One retry with this sharper contract; a still-
 * unreadable result pauses the loop instead of feeding a phantom FAIL back
 * (which loops forever).
 */
export function strictVerifyPrompt(ticket: GoalTicket, verifyFile: string): string {
  return [
    verifyPrompt(ticket, verifyFile),
    ``,
    `IMPORTANT: your previous verification produced no readable verdict file at`,
    `${verifyFile}. Write that file — one line, PASS or FAIL: <reason> — using the`,
    `Write tool. Do not reply with prose instead of writing the file.`,
  ].join("\n");
}

/** Parse the verification FILE (strict: single PASS / FAIL: line). */
export function parseVerifyFile(content: string): { pass: boolean; reason?: string } | null {
  const text = content.trim();
  if (text === "PASS" || text.startsWith("PASS\n")) return { pass: true };
  const m = /^FAIL:\s*(.+)/s.exec(text);
  if (m) return { pass: false, reason: m[1]!.trim().slice(0, 400) };
  return null;
}

/**
 * Parse the verification reply (fallback when no verdict file was written).
 * Explicit "FAIL:" wins; otherwise any pass/passed mention counts.
 */
export function parseVerifyReply(reply: string): { pass: boolean; reason?: string } | null {
  const text = reply.trim();
  const m = /fail\s*:\s*(.+)/is.exec(text);
  if (m) return { pass: false, reason: m[1]!.trim().slice(0, 400) };
  if (/\bpass(ed)?\b/i.test(text)) return { pass: true };
  return null;
}

/** The worker's self-reported verdict from the last assistant reply. */
export interface Verdict {
  kind: "met" | "not-yet" | "impossible";
  gaps?: string;
  why?: string;
}

/** Parse the trailing VERDICT line from a dispatch reply; null when absent. */
export function parseVerdict(reply: string): Verdict | null {
  const m = /VERDICT:\s*(met|not-yet|impossible)\b([^\n]*)/i.exec(reply);
  if (!m) return null;
  const kind = m[1]!.toLowerCase() as Verdict["kind"];
  const rest = reply.slice(m.index + m[0].length);
  const gaps = /GAPS:\s*([^\n]+)/i.exec(rest)?.[1]?.trim();
  const why = /WHY:\s*([^\n]+)/i.exec(rest)?.[1]?.trim();
  return { kind, gaps, why };
}

/**
 * Handoff turn prompt: the model writes the snapshot itself (rich state lives
 * in files, not in driver-managed blobs — see ADR-0022 §6). Distills the
 * handoff skill's rules: fixed path, no secrets, reference artifacts by path.
 */
export function handoffPrompt(opts: { objective: string; handoffFile: string }): string {
  return [
    `# Goal loop handoff (context is about to be compacted)`,
    ``,
    `Write a handoff document with the Write tool to EXACTLY this path:`,
    opts.handoffFile,
    ``,
    `Contents (markdown, under ~300 tokens, English):`,
    `1. Objective: ${opts.objective}`,
    `2. Tickets: current status of each (done / in progress / blocked, one line each)`,
    `3. Key knowledge: decisions, gotchas, file locations the next round needs`,
    `4. Artifact trail: paths of specs/plans/diffs created so far (reference by`,
    `   path — do NOT copy their contents)`,
    `5. Next step: the single next action`,
    ``,
    `If the file already exists, INTEGRATE it: carry forward anything still true,`,
    `drop what is obsolete (the anchor rule — successive compactions must not`,
    `lose information that still matters).`,
    `Omit secrets (API keys, credentials, PII).`,
    ``,
    `Reply with only: DONE`,
  ].join("\n");
}

/** Post-compaction continuation note riding the next dispatch's user steer. */
export function handoffReadbackNote(handoffFile: string): string {
  return `Context was compacted; resumed from handoff (${handoffFile}).`;
}
