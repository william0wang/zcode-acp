import { describe, expect, it } from "vitest";

import { MouseSequenceFilter } from "../src/repl/mouse.js";

/** Drive filter.feed and collect wheel callbacks alongside the clean text. */
function run(chunks: string[]): { out: string[]; wheels: Array<string> } {
  const wheels: Array<string> = [];
  const f = new MouseSequenceFilter((dir) => wheels.push(dir));
  return { out: chunks.map((c) => f.feed(c)), wheels };
}

describe("MouseSequenceFilter", () => {
  it("extracts SGR wheel events with no passthrough leakage", () => {
    const { out, wheels } = run(["\x1b[<64;10;20M", "\x1b[<65;3;4m"]);
    expect(out).toEqual(["", ""]);
    // Wheels are instant: no de-dup against the release suffix (real
    // terminals never send one anyway); treat m == M tolerantly.
    expect(wheels).toEqual(["up", "down"]);
  });

  it("passes plain text through byte-identical", () => {
    const { out, wheels } = run(["hello world ", "中文输入 ✓\n"]);
    expect(out.join("")).toBe("hello world 中文输入 ✓\n");
    expect(wheels).toEqual([]);
  });

  it("filters events embedded mid-text", () => {
    const { out, wheels } = run(["abc\x1b[<64;1;1Mdef\x1b[<65;2;2Mghi"]);
    expect(out.join("")).toBe("abcdefghi");
    expect(wheels).toEqual(["up", "down"]);
  });

  it("reassembles a sequence split across chunk boundaries", () => {
    const { out, wheels } = run(["tex\x1b", "t\x1b[<6", "4;15;30Mmore"]);
    // The lone ESC before "t" isn't a candidate; it re-emits verbatim.
    expect(out.join("")).toBe("tex\x1btmore");
    expect(wheels).toEqual(["up"]);
  });

  it("holds an incomplete candidate until the chunk that completes it", () => {
    const { out, wheels } = run(["tail\x1b[<65;", "34;56M"]);
    expect(out.join("")).toBe("tail");
    expect(wheels).toEqual(["down"]);
  });

  it("keeps keyboard CSI sequences (arrows) intact", () => {
    const seqs = "\x1b[A\x1b[B\x1b[C\x1b[D\x1b[5~\x1b[H";
    const { out, wheels } = run([`a${seqs}b`]);
    expect(out.join("")).toBe(`a${seqs}b`);
    expect(wheels).toEqual([]);
  });

  it("drops drag/motion/click noise without emitting anything", () => {
    // 32 = motion w/ button-1, 0/0(m) = left click press/release pairs.
    const { out, wheels } = run(["\x1b[<32;5;5M\x1b[<0;5;5M\x1b[<0;5;5m"]);
    expect(out.join("")).toBe("");
    expect(wheels).toEqual([]);
  });

  it("flushes a pathological dangling prefix verbatim", () => {
    const garbage = "\x1b[<" + "9".repeat(200);
    const { out, wheels } = run([garbage]);
    expect(out.join("")).toBe(garbage);
    expect(wheels).toEqual([]);
  });

  it("flushes held state when a later chunk invalidates it", () => {
    const f = new MouseSequenceFilter(() => {});
    expect(f.feed("\x1b[<64;")).toBe(""); // held
    // Invalid continuation ("x") — the whole held tail must resurface, then
    // normal text flows again.
    expect(f.feed("x hello")).toBe("\x1b[<64;x hello");
  });
});
