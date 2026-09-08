#!/usr/bin/env node
/**
 * Build step: hash every .js under dist/ (sorted, path+content) into
 * dist/code-fingerprint.json. The hub-vs-bridge staleness handshake compares
 * CONTENT, not version numbers or mtimes — a version can lie (a hub started
 * between a release merge and the dist rebuild reports the new version while
 * running old code) and an mtime can be preserved or skewed (cp -p, rsync,
 * clock drift). Content cannot. Run AFTER tsc; part of `pnpm build` so the
 * npm tarball ships the file (prepublishOnly builds first).
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const distDir = fileURLToPath(new URL("../dist/", import.meta.url));

async function collectJsFiles(current, out) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) await collectJsFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(full);
  }
}

const files = [];
await collectJsFiles(distDir, files);
files.sort();

if (files.length === 0) {
  console.error("write-code-fingerprint: no .js files under dist/ — run tsc first");
  process.exit(1);
}

const combined = createHash("sha256");
for (const file of files) {
  combined.update(path.relative(distDir, file));
  combined.update("\0");
  combined.update(await readFile(file));
}

const fingerprint = combined.digest("hex");
const outFile = path.join(distDir, "code-fingerprint.json");
await mkdir(distDir, { recursive: true });
await writeFile(outFile, `${JSON.stringify({ fingerprint, fileCount: files.length }, null, 2)}\n`);
console.log(`write-code-fingerprint: ${fingerprint.slice(0, 12)}… over ${files.length} files`);
