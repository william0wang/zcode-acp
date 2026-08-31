/**
 * input-buffer paste tests — foldPasteChunk (ADR-0009).
 *
 * A newline inside a pasted chunk must never keep its Enter semantics:
 * pre-fix, planChunkOps replayed \r/\n per-character and every paragraph of
 * a multi-line paste fired as its own prompt. These cases pin the folding
 * rules AND the boundary (planChunkOps still treats a lone \r as semantic,
 * which is what keeps a real Enter keypress submitting).
 */

import { describe, expect, it } from "vitest";

import { foldPasteChunk, MAX_PROMPT_CHARS, planChunkOps } from "../src/repl/input-buffer.js";

describe("foldPasteChunk", () => {
  it("strips bracketed-paste wrappers", () => {
    expect(foldPasteChunk("\x1b[200~hello world\x1b[201~")).toBe("hello world");
  });

  it("folds CRLF, LF and CR to single spaces", () => {
    expect(foldPasteChunk("para one\r\npara two")).toBe("para one para two");
    expect(foldPasteChunk("a\nb")).toBe("a b");
    expect(foldPasteChunk("a\rb")).toBe("a b");
  });

  it("collapses newline runs (blank lines) to one space", () => {
    expect(foldPasteChunk("a\n\n\nb")).toBe("a b");
  });

  it("folds tabs, which would otherwise trigger completion", () => {
    expect(foldPasteChunk("key\tvalue")).toBe("key value");
  });

  it("keeps emoji, CJK and printable text untouched", () => {
    expect(foldPasteChunk("中文 🎉 paste")).toBe("中文 🎉 paste");
  });

  it("drops stray control and escape bytes", () => {
    expect(foldPasteChunk("a\x1bb\x00c\x7fd")).toBe("abcd");
  });

  it("returns empty for a whitespace-only paste", () => {
    expect(foldPasteChunk("\x1b[200~\r\n\r\n\x1b[201~")).toBe("");
  });

  it("caps the folded result at MAX_PROMPT_CHARS", () => {
    const huge = "\x1b[200~" + "x".repeat(MAX_PROMPT_CHARS + 1000) + "\x1b[201~";
    expect(foldPasteChunk(huge).length).toBe(MAX_PROMPT_CHARS);
  });

  it("caps by code points — never splits a surrogate pair at the boundary", () => {
    const chunk = "x".repeat(MAX_PROMPT_CHARS - 1) + "😀y";
    const out = foldPasteChunk(chunk);
    expect(Array.from(out).length).toBe(MAX_PROMPT_CHARS);
    expect(out.endsWith("😀")).toBe(true);
  });
});

describe("planChunkOps boundary vs paste folding", () => {
  it("still replays a lone semantic Enter per-character (real keypress submits)", () => {
    const ops = planChunkOps("hi\r");
    expect(ops).toEqual([
      { kind: "insert", text: "hi" },
      { kind: "char", ch: "\r" },
    ]);
  });

  it("never emits newline semantics — callers fold those chunks before routing", () => {
    // Pin the contract the App relies on: wrapped paste text fed through
    // foldPasteChunk first yields insert-only ops.
    const folded = foldPasteChunk("\x1b[200~a\r\nb\x1b[201~");
    expect(planChunkOps(folded)).toEqual([{ kind: "insert", text: "a b" }]);
  });
});
