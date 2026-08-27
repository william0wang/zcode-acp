/**
 * Mouse-wheel capture for the full-screen REPL (alternate-screen mode).
 *
 * Enabling xterm mouse reporting (?1000 press/release + ?1002 drag +
 * ?1006 SGR encoding) re-routes the terminal's wheel from its own scrollback
 * scroll to escape sequences delivered to us — `\x1b[<64;col;rowM` = wheel
 * up, `\x1b[<65;…M` = wheel down. The terminal stops scrolling entirely,
 * which is what prevents Warp from scrolling the alt-screen frame away
 * (warp#9838); vim/tmux/htop scroll correctly inside Warp via this exact
 * mechanism.
 *
 * Ink knows nothing about mouse sequences, so raw bytes must never reach it:
 * this module owns the REAL process.stdin as its sole consumer, strips
 * complete SGR mouse events out of the byte stream, forwards everything
 * else into a fake stdin handed to ink via `render({stdin})`, and reports
 * wheel notches through a callback.
 */

import { PassThrough } from "node:stream";

/** DECSET sequences arming SGR mouse reporting on the terminal. */
export const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";

/** Matching resets — idempotent, safe to write more than once. */
export const MOUSE_DISABLE = "\x1b[?1000l\x1b[?1002l\x1b[?1006l";

export type WheelDirection = "up" | "down";

/** Longest legitimate SGR mouse event is well under 32 bytes; beyond this a
 * dangling `\x1b[<` prefix is garbage and gets flushed verbatim. */
const MAX_PENDING = 64;

/**
 * Incremental splitter: feed() raw stdin chunks, get back display-safe text
 * with every mouse event removed, and receive wheel callbacks for events.
 * Holds an incomplete trailing sequence until the rest arrives in a later
 * chunk.
 */
export class MouseSequenceFilter {
  private pending = "";

  constructor(private readonly onWheel: (dir: WheelDirection) => void) {}

  /** Feed one raw chunk; returns the passthrough text (may be empty). */
  feed(chunk: string): string {
    let buf = this.pending + chunk;
    if (!buf.includes("\x1b")) return buf;
    let out = "";
    let i = 0;
    while (i < buf.length) {
      if (buf[i] !== "\x1b") {
        out += buf[i];
        i++;
        continue;
      }
      const match = scanMouseEvent(buf, i);
      if (match === null) {
        // Ran off the end mid-candidate: hold the tail for the next chunk.
        this.pending = buf.slice(i);
        if (this.pending.length > MAX_PENDING) {
          out += this.pending; // pathological — flush verbatim instead of eating input
          this.pending = "";
        }
        return out;
      }
      if (!match.passthrough) {
        if (match.dir !== null) this.onWheel(match.dir);
      } else {
        out += "\x1b"; // lone ESC / non-mouse CSI: byte-identical passthrough
      }
      i += match.consumed;
    }
    this.pending = "";
    return out;
  }
}

type ScanResult =
  | { passthrough: false; dir: WheelDirection | null; consumed: number }
  | { passthrough: true; consumed: number };

/**
 * Match one SGR mouse event at `start` (which must be ESC):
 * `\x1b[<button;column;row(M|m)` — M = press/drag, m = release. Returns null
 * when the buffer ends mid-candidate; `{passthrough: true}` when what follows
 * is not a mouse event (arrow keys, other CSI, plain text) — only the ESC
 * itself is "consumed", the caller re-emits it verbatim.
 */
function scanMouseEvent(s: string, start: number): ScanResult | null {
  let i = start + 1;
  if (i >= s.length) return null; // can't tell yet — maybe "[…" next chunk
  if (s.charCodeAt(i) !== 0x5b /* [ */) return passthroughEsc();
  i++;
  if (i >= s.length) return null; // "[<" possible
  if (s.charCodeAt(i) !== 0x3c /* < */) return passthroughEsc();
  const paramsStart = i + 1;
  let finalIdx = -1;
  for (let k = paramsStart; k < s.length; k++) {
    const ch = s[k];
    if ((ch >= "0" && ch <= "9") || ch === ";") continue;
    if (ch === "M" || ch === "m") {
      finalIdx = k;
      break;
    }
    return passthroughEsc(); // some other CSI-x sequence, not ours
  }
  if (finalIdx === -1) return null; // still valid-looking but incomplete
  const params = s.slice(paramsStart, finalIdx).split(";");
  // Wheel buttons per xterm ctlseqs: 64 = wheel up, 65 = wheel down. Drag /
  // motion / release codes arrive too once ?1002h is armed — drop silently.
  const button = Number.parseInt(params[0] ?? "", 10);
  const dir: WheelDirection | null = button === 64 ? "up" : button === 65 ? "down" : null;
  return { passthrough: false, dir, consumed: finalIdx + 1 - start };
}

function passthroughEsc(): ScanResult {
  return { passthrough: true, consumed: 1 };
}

export interface FilteredStdin {
  /** Ink-facing stream — pass to render({stdin}). */
  stream: NodeJS.ReadStream;
  /** Stop capturing and tear down listeners on the real stdin. */
  dispose(): void;
}

/**
 * Take over process.stdin, strip mouse events, expose the cleaned stream for
 * ink. The fake stream forwards TTY identity and lifecycle calls (ink sets
 * raw mode, ref/unrefs it, and consumes via 'readable'+read()); keyboard data
 * flows through unchanged byte-for-byte.
 */
export function createFilteredStdin(onWheel: (dir: WheelDirection) => void): FilteredStdin {
  const real = process.stdin;
  // Chunks are utf8 strings downstream of us; decoding here keeps CJK and
  // escape bytes aligned across chunk boundaries.
  real.setEncoding("utf8");

  const filter = new MouseSequenceFilter(onWheel);
  const fake = new PassThrough();
  Object.defineProperty(fake, "isTTY", { value: real.isTTY });
  const proxy = fake as unknown as Record<string, unknown>;
  proxy.setRawMode = (mode: boolean): void => {
    try {
      real.setRawMode(mode);
    } catch {
      // non-TTY stdin (tests): ink skips raw mode via isTTY anyway
    }
  };
  proxy.ref = (): void => {
    real.ref();
  };
  proxy.unref = (): void => {
    real.unref();
  };

  const onData = (chunk: string): void => {
    const clean = filter.feed(chunk);
    if (clean.length > 0 && !fake.destroyed) fake.write(clean);
  };
  const endFake = (): void => {
    if (!fake.destroyed) fake.end();
  };
  real.on("data", onData);
  real.once("end", endFake);

  return {
    stream: fake as unknown as NodeJS.ReadStream,
    dispose(): void {
      real.off("data", onData);
      real.off("end", endFake);
      endFake();
    },
  };
}
