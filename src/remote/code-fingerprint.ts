/**
 * Runtime read of the build-time dist content fingerprint
 * (scripts/write-code-fingerprint.mjs → dist/code-fingerprint.json).
 *
 * Null when absent: running from src (dev), or a dist built before the
 * fingerprint step existed — callers must fall back to the legacy
 * version-number comparison then, never treat null as a mismatch.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** dist/remote/x.js → dist/code-fingerprint.json (dist/ root in tests). */
export function codeFingerprintPath(distDir?: string): string {
  return distDir
    ? `${distDir.replace(/\/$/, "")}/code-fingerprint.json`
    : fileURLToPath(new URL("../code-fingerprint.json", import.meta.url));
}

/** Read the fingerprint; null when the file is missing or malformed. */
export function readCodeFingerprint(distDir?: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(codeFingerprintPath(distDir), "utf8")) as {
      fingerprint?: unknown;
    };
    return typeof parsed.fingerprint === "string" ? parsed.fingerprint : null;
  } catch {
    return null;
  }
}
