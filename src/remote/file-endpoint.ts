/**
 * Read-only session file endpoint (ADR-0004), served on the bridge's loopback
 * HTTP server next to /acp and byte-proxied by the hub at
 * /api/instances/{id}/fs/*. Two routes:
 *
 *   GET /fs/list?sessionId=&path=<relative-to-root>   — one directory level
 *   GET /fs/file?sessionId=&path=                      — file bytes
 *       [&offset=&length=] byte range  |  [&line=&limit=] text lines
 *
 * Every path is resolved against the session's root cwd (the Session Root)
 * and must stay inside it after realpath — `..` segments and symlinks that
 * escape the root are rejected. The endpoint is loopback-only and carries no
 * auth of its own, exactly like the ACP WebSocket beside it; the hub is the
 * only public entry and enforces the token.
 */

import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import path from "node:path";

import type { ZcodeAcpServer } from "../server.js";

/** Max directory entries per /fs/list before truncation. */
const LIST_ENTRY_LIMIT = 2000;
/** /fs/file line-window defaults and cap (line mode only). */
const DEFAULT_LINE_LIMIT = 200;
const MAX_LINE_LIMIT = 5000;

/** Common extensions; everything else is served as octet-stream. */
const MIME_BY_EXT: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".jsonc": "application/json",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".ts": "text/plain",
  ".tsx": "text/plain",
  ".jsx": "text/plain",
  ".css": "text/css",
  ".html": "text/html",
  ".htm": "text/html",
  ".svg": "image/svg+xml",
  ".xml": "application/xml",
  ".yml": "text/plain",
  ".yaml": "text/plain",
  ".toml": "text/plain",
  ".ini": "text/plain",
  ".env": "text/plain",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".py": "text/plain",
  ".rb": "text/plain",
  ".go": "text/plain",
  ".rs": "text/plain",
  ".java": "text/plain",
  ".kt": "text/plain",
  ".c": "text/plain",
  ".h": "text/plain",
  ".cpp": "text/plain",
  ".hpp": "text/plain",
  ".cs": "text/plain",
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".zsh": "text/x-shellscript",
  ".sql": "text/plain",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

function mimeFor(file: string): string {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

function sendText(res: ServerResponse, code: number, message: string): void {
  if (res.writableEnded) return;
  res.writeHead(code, { "Content-Type": "text/plain" });
  res.end(message);
}

/** Parse a non-negative integer query param: null when absent, NaN when invalid. */
function parseCount(raw: string | null): number | null {
  if (raw === null) return null;
  return /^\d+$/.test(raw) ? Number(raw) : NaN;
}

/**
 * Resolve the Session Root for a sessionId: the cwd recorded in sessionCwds,
 * canonicalized via realpath so later prefix checks compare real paths.
 * Answers (and returns null) when the session is unknown or its root is gone.
 */
async function sessionRoot(
  server: ZcodeAcpServer,
  sessionId: string | null,
  res: ServerResponse,
): Promise<string | null> {
  if (!sessionId) {
    sendText(res, 400, "sessionId required");
    return null;
  }
  const cwd = server.sessionCwds.get(sessionId);
  if (!cwd) {
    // Unknown to this bridge — 403, not 404, so a probing client cannot
    // distinguish "no such session" from "none of your business".
    sendText(res, 403, "unknown session");
    return null;
  }
  // Defense in depth: a session root of "/" is never legitimate (projects
  // live in subdirectories; "/" could only come from a polluted cwd record).
  // Serving it would expose the whole filesystem to remote clients.
  if (cwd === "/") {
    sendText(res, 403, "session root unavailable");
    return null;
  }
  try {
    const real = await realpath(cwd);
    if (real === "/") {
      sendText(res, 403, "session root unavailable");
      return null;
    }
    return real;
  } catch {
    sendText(res, 404, "session root unavailable");
    return null;
  }
}

/**
 * Resolve `rel` inside `root` and prove the real path stays inside it.
 * Rejects `..` traversal and symlinks pointing outside the root (403) and
 * missing targets (404). `rel` may be absolute as long as it lands inside.
 */
async function resolveInside(
  root: string,
  rel: string | null,
  res: ServerResponse,
): Promise<string | null> {
  const target = rel ? path.resolve(root, rel) : root;
  let real: string;
  try {
    real = await realpath(target);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    sendText(res, code === "ENOENT" ? 404 : 403, code === "ENOENT" ? "not found" : "unreadable");
    return null;
  }
  if (real !== root && !real.startsWith(root + path.sep)) {
    sendText(res, 403, "path escapes session root");
    return null;
  }
  return real;
}

interface ListEntry {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
}

async function handleList(
  server: ZcodeAcpServer,
  url: URL,
  res: ServerResponse,
  head: boolean,
): Promise<void> {
  const root = await sessionRoot(server, url.searchParams.get("sessionId"), res);
  if (root === null) return;
  const dir = await resolveInside(root, url.searchParams.get("path"), res);
  if (dir === null) return;

  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOTDIR") {
      sendText(res, 404, "not a directory");
      return;
    }
    sendText(res, 403, "unreadable");
    return;
  }

  dirents.sort((a, b) => {
    const aDir = a.isDirectory() ? 0 : 1;
    const bDir = b.isDirectory() ? 0 : 1;
    return aDir !== bDir ? aDir - bDir : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const truncated = dirents.length > LIST_ENTRY_LIMIT;
  const visible = truncated ? dirents.slice(0, LIST_ENTRY_LIMIT) : dirents;

  const entries: ListEntry[] = [];
  for (const d of visible) {
    const kind = d.isDirectory() ? "dir" : d.isSymbolicLink() ? "symlink" : "file";
    // Symlinks report placeholder stats: their target is resolved (and
    // scope-checked) only when the client reads through them.
    let size = 0;
    let mtime = 0;
    if (kind !== "symlink") {
      try {
        const s = await stat(path.join(dir, d.name));
        size = s.size;
        mtime = s.mtimeMs;
      } catch {
        /* raced deletion — keep placeholder zeros */
      }
    }
    entries.push({ name: d.name, kind, size, mtime });
  }

  const body = JSON.stringify({ root, entries, truncated });
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(head ? undefined : body);
}

/**
 * Serve a text window: stream the file line by line, skip to `line` (1-based)
 * and collect up to `limit` lines. Memory is O(limit) regardless of file
 * size, which is why line mode needs no byte cap of its own. The window is
 * delivered as text; `X-Zcode-First-Line` carries the first served line.
 */
async function streamLines(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  line: number,
  limit: number,
): Promise<void> {
  const input = createReadStream(file, { encoding: "utf8" });
  const rl = createInterface({ input, crlfDelay: Infinity });
  const lines: string[] = [];
  let n = 0;
  let aborted = false;
  req.on("close", () => {
    aborted = true;
  });
  try {
    for await (const text of rl) {
      if (aborted) return;
      n += 1;
      if (n < line) continue;
      lines.push(text);
      if (lines.length >= limit) break;
    }
  } finally {
    rl.close();
    input.destroy();
  }
  if (aborted || res.writableEnded) return;
  const body = lines.length > 0 ? lines.join("\n") + "\n" : "";
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Zcode-First-Line": String(Math.min(line, n + 1)),
  });
  res.end(body);
}

async function handleFile(
  server: ZcodeAcpServer,
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
  head: boolean,
): Promise<void> {
  const offset = parseCount(url.searchParams.get("offset"));
  const length = parseCount(url.searchParams.get("length"));
  const line = parseCount(url.searchParams.get("line"));
  const limit = parseCount(url.searchParams.get("limit"));
  if ([offset, length, line, limit].some((v) => Number.isNaN(v))) {
    sendText(res, 400, "range parameters must be non-negative integers");
    return;
  }
  const hasByte = offset !== null || length !== null;
  const hasLine = line !== null || limit !== null;
  if (hasByte && hasLine) {
    sendText(res, 400, "offset/length and line/limit are mutually exclusive");
    return;
  }

  const root = await sessionRoot(server, url.searchParams.get("sessionId"), res);
  if (root === null) return;
  const file = await resolveInside(root, url.searchParams.get("path"), res);
  if (file === null) return;

  const s = await stat(file).catch(() => null);
  if (!s || !s.isFile()) {
    sendText(res, 404, "not a file");
    return;
  }
  const mime = mimeFor(file);

  if (hasLine) {
    const startLine = Math.max(1, line ?? 1);
    const lineLimit = Math.min(MAX_LINE_LIMIT, Math.max(1, limit ?? DEFAULT_LINE_LIMIT));
    if (head) {
      // The window size is unknowable without reading — header only.
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end();
      return;
    }
    await streamLines(req, res, file, startLine, lineLimit);
    return;
  }

  const start = offset ?? 0;
  const end = hasByte ? Math.min(start + (length ?? s.size) - 1, s.size - 1) : undefined;
  if (hasByte && start > s.size - 1) {
    res.writeHead(416, { "Content-Range": `bytes */${s.size}` });
    res.end();
    return;
  }

  if (head) {
    // Same headers the GET would send, no body.
    const headers: Record<string, string> = { "Content-Type": mime };
    if (hasByte) {
      headers["Content-Range"] = `bytes ${start}-${end}/${s.size}`;
      headers["Content-Length"] = String(end! - start + 1);
    } else {
      headers["Content-Length"] = String(s.size);
    }
    res.writeHead(hasByte ? 206 : 200, headers);
    res.end();
    return;
  }

  const stream = createReadStream(file, hasByte ? { start, end } : undefined);
  stream.on("error", () => {
    // stat passed, so this is a mid-transfer failure (unlink/EACCES race) —
    // the header is already out; dropping the connection is the only signal.
    res.destroy();
  });
  req.on("close", () => stream.destroy());
  const headers: Record<string, string> = { "Content-Type": mime };
  if (hasByte) {
    headers["Content-Range"] = `bytes ${start}-${end}/${s.size}`;
    headers["Content-Length"] = String(end! - start + 1);
  } else {
    headers["Content-Length"] = String(s.size);
  }
  res.writeHead(hasByte ? 206 : 200, headers);
  stream.pipe(res);
}

/**
 * Build the /fs request handler for the loopback endpoint. Never throws —
 * every failure path answers with a status code.
 */
export function createFileHandler(
  server: ZcodeAcpServer,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendText(res, 405, "method not allowed");
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const head = req.method === "HEAD";
    let route: Promise<void> | null;
    if (url.pathname === "/fs/list") route = handleList(server, url, res, head);
    else if (url.pathname === "/fs/file") route = handleFile(server, req, url, res, head);
    else route = null;
    if (route === null) {
      sendText(res, 404, "not found");
      return;
    }
    route.catch(() => {
      // Unexpected async failures must not reach the event loop.
      if (res.headersSent) res.destroy();
      else sendText(res, 500, "internal error");
    });
  };
}
