/**
 * The ZCode encrypted credential store (`~/.zcode/v2/credentials.json`).
 *
 * The desktop app keeps current-account secrets there — OAuth tokens and the
 * per-plan coding-plan API keys (`account-provider:coding-plan:account:<plan>:
 * account:<uid>:api-key`) — AES-256-GCM encrypted, keyed by
 * `ZCODE_CREDENTIAL_SECRET` or a machine-bound fallback string (sha256 of the
 * secret as the key; wire form `enc:v1:<iv>.<authTag>.<ciphertext>`, base64url;
 * plaintext entries pass through unchanged).
 *
 * The cipher primitives are shared with the settings reset-card flow
 * (settings/coding-plan.ts). This module adds the SYNC reader the account
 * snapshot needs — `answerProviderRuntimeHeaders` runs on the frame-arrival
 * path and cannot await — with an mtime+size cache so per-request callers
 * never re-decrypt an unchanged store.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { log, zcodeCredentialsPath } from "../utils.js";

const ENCRYPTED_PREFIX = "enc:v1:";
const V2_OS_PREFIX = "enc:v2:os:";
const CIPHER_ALGORITHM = "aes-256-gcm";
/** The desktop/CLI store the OS-keyring key under this service (bundle-verified 2026-11-11). */
const KEYRING_SERVICE = "ZCode Credential Encryption";

/** Machine-bound fallback secret, mirroring ZCode's credential cipher. */
export function resolveCredentialSecret(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ZCODE_CREDENTIAL_SECRET?.trim();
  if (configured) return configured;
  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    /* sandboxed runtimes may not resolve it */
  }
  return `zcode-credential-fallback:${platform()}:${homedir()}:${username}`;
}

/**
 * Decrypt one `enc:v1:` credential value.
 *
 * The wire form is `enc:v1:<iv>.<authTag>.<ciphertext>`, all base64url. A value
 * without the prefix is returned as-is (plaintext entries exist in the wild).
 */
export function decryptCredential(value: string, secret: string): string {
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value;
  const payload = value.slice(ENCRYPTED_PREFIX.length);
  const parts = payload.split(".");
  if (parts.length !== 3) throw new Error("credential_decrypt_malformed");
  const [ivRaw, tagRaw, cipherRaw] = parts as [string, string, string];
  const iv = Buffer.from(ivRaw, "base64url");
  const authTag = Buffer.from(tagRaw, "base64url");
  const cipherText = Buffer.from(cipherRaw, "base64url");
  const key = createHash("sha256").update(secret).digest();
  try {
    const decipher = createDecipheriv(CIPHER_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(cipherText), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("credentials_unavailable");
  }
}

/**
 * The OS-keyring key for `enc:v2:os:` values, mirroring the CLI's own
 * resolution (bundle-verified 2026-11-11): the key is a random 32-byte
 * base64url secret stored in the platform credential vault under service
 * "ZCode Credential Encryption" and account = hex(sha256(resolved
 * credentials.json path)). Uses @napi-rs/keyring — the same native package
 * the CLI imports — so the bridge reads exactly what the desktop wrote.
 * Returns null when the keyring is unavailable or holds no key (callers fall
 * back to the legacy cipher path).
 */
const keyringEntryCache = new Map<string, { getPassword(): string | null } | null>();
function v2OsKeyForCredentialsFile(file: string): Buffer | null {
  const account = createHash("sha256").update(path.resolve(file)).digest("hex");
  let entry = keyringEntryCache.get(account);
  if (entry === undefined) {
    try {
      const req = createRequire(import.meta.url);
      const { Entry } = req("@napi-rs/keyring") as {
        Entry: new (service: string, account: string) => { getPassword(): string | null };
      };
      entry = new Entry(KEYRING_SERVICE, account);
    } catch {
      entry = null; // native module unavailable on this platform
    }
    keyringEntryCache.set(account, entry);
  }
  if (!entry) return null;
  try {
    const password = entry.getPassword();
    if (!password || !/^[A-Za-z0-9_-]{43}$/.test(password)) return null;
    const key = Buffer.from(password, "base64url");
    return key.length === 32 ? key : null;
  } catch {
    return null; // no key stored yet (pre-migration store)
  }
}

/**
 * Decrypt one `enc:v2:os:` value.
 *
 * Wire format (from the CLI's own encrypt, bundle-verified 2026-11-11):
 *   enc:v2:os:<source>:<fp24>:<ivB64url>.<tagB64url>.<dataB64url>
 * where `<fp24>` = hex(sha256(key)).slice(0, 24) — a checksum of the keyring
 * key that lets us pick/verify the right key — and the payload segments use
 * the same GCM layout as v1 (iv 12B, tag 16B, AES-256-GCM).
 */
function decryptV2Os(value: string, key: Buffer): string {
  const rest = value.slice(V2_OS_PREFIX.length);
  const colon = rest.indexOf(":");
  if (colon === -1) throw new Error("credential_decrypt_malformed");
  const fingerprint = rest.slice(0, colon);
  const expected = createHash("sha256").update(key).digest("hex").slice(0, 24);
  if (fingerprint !== expected) throw new Error("credential_decrypt_key_mismatch");
  const parts = rest.slice(colon + 1).split(".");
  if (parts.length !== 3) throw new Error("credential_decrypt_malformed");
  const [ivRaw, tagRaw, cipherRaw] = parts as [string, string, string];
  const iv = Buffer.from(ivRaw, "base64url");
  const authTag = Buffer.from(tagRaw, "base64url");
  const cipherText = Buffer.from(cipherRaw, "base64url");
  try {
    const decipher = createDecipheriv(CIPHER_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(cipherText), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("credentials_unavailable");
  }
}

export interface StoreCache {
  file: string;
  secret: string;
  mtimeMs: number;
  size: number;
  entries: Record<string, string>;
}

/**
 * Serve the backend's `interaction/requestCredentialCipher` ask: encrypt or
 * decrypt one credential value with the OS-keyring key. The CLI delegates
 * these ops to its host when the store is v2 (enc:v2:os is unreadable without
 * the keyring, and the keyring is exactly what the bridge CAN reach via
 * @napi-rs/keyring).
 *
 * Returns the operation result string, or null when the operation cannot be
 * served on this machine (no keyring key) — the caller then declines.
 */
export function credentialCipherOp(operation: string, value: string): string | null {
  const file = zcodeCredentialsPath();
  const key = v2OsKeyForCredentialsFile(file);
  if (!key) return null;
  const fingerprint = createHash("sha256").update(key).digest("hex").slice(0, 24);
  if (operation === "decrypt") {
    if (value.startsWith(V2_OS_PREFIX)) return decryptV2Os(value, key);
    // Legacy v1 remnants decrypt with the fallback secret when present.
    try {
      return decryptCredential(value, resolveCredentialSecret());
    } catch {
      return null;
    }
  }
  if (operation === "encrypt") {
    const iv = randomBytes(12);
    const cipher = createCipheriv(CIPHER_ALGORITHM, key, iv);
    const cipherText = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${V2_OS_PREFIX}os:${fingerprint}:${[
      iv.toString("base64url"),
      tag.toString("base64url"),
      cipherText.toString("base64url"),
    ].join(".")}`;
  }
  return null;
}

let storeCache: StoreCache | null = null;

/**
 * Read and decrypt the credential store, synchronously. Returns `{}` when the
 * store is missing or unreadable (a headless-only machine has none). Entries
 * that fail to decrypt are skipped individually — the store also holds OAuth
 * discovery state and other secrets no caller here needs. Cached per
 * mtime+size+secret, so the per-request callers never re-decrypt an unchanged
 * store.
 */
export function readCredentialStoreSync(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const file = zcodeCredentialsPath();
  let mtimeMs: number;
  let size: number;
  try {
    const st = statSync(file);
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch {
    storeCache = null;
    return {};
  }
  const secret = resolveCredentialSecret(env);
  if (
    storeCache &&
    storeCache.file === file &&
    storeCache.secret === secret &&
    storeCache.mtimeMs === mtimeMs &&
    storeCache.size === size
  ) {
    return storeCache.entries;
  }
  const out: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    // v2:os values are keyed by the OS-keyring key for THIS store file; fetch
    // it once per read. null → the keyring holds no key for this file (legacy
    // store) and every v2:os entry is skipped with a single note.
    let v2Key: Buffer | null | undefined;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "string") continue;
      try {
        if (value.startsWith(V2_OS_PREFIX)) {
          if (v2Key === undefined) v2Key = v2OsKeyForCredentialsFile(file);
          if (v2Key === null) {
            log(`credential-store: '${key}' is enc:v2:os but no OS-keyring key resolved — skipped`);
            continue;
          }
          out[key] = decryptV2Os(value, v2Key);
          continue;
        }
        out[key] = decryptCredential(value, secret);
      } catch (error) {
        // One undecryptable entry must not sink the rest (same posture as the
        // settings reader).
        log(
          `credential-store: '${key}' could not be read (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
  } catch (e) {
    log(
      `credential-store: unreadable store (${e instanceof Error ? e.message : String(e)}) — treating as empty`,
    );
    return {};
  }
  storeCache = { file, secret, mtimeMs, size, entries: out };
  return out;
}
