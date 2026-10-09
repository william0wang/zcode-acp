/** Bridge-owned Coding Plan keys. Desktop configuration is never modified. */
import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { mkdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { zcodeHomeDir } from "../utils.js";
import { builtinTablePath } from "./account-provider.js";

export type CodingPlanFamily = "zai" | "bigmodel";
type Accounts = Partial<Record<CodingPlanFamily, { apiKey: string }>>;
interface Provider {
  name?: string;
  kind?: string;
  enabled?: boolean;
  options?: { apiKey?: string; baseURL?: string };
  models?: Record<string, unknown>;
}
export interface CredentialConfig {
  provider?: Record<string, Provider>;
}

export function bridgeAccountsPath(): string {
  return path.join(zcodeHomeDir(), "v2", "acp-accounts.json");
}

function validKey(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 4096 && /^[!-~]+$/u.test(value)
  );
}

export function readBridgeAccounts(file = bridgeAccountsPath()): Accounts {
  let fd: number;
  try {
    // lstat also rejects dangling links on platforms without O_NOFOLLOW.
    if (lstatSync(file).isSymbolicLink()) throw new Error("Linked bridge account configuration");
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Cannot read bridge account configuration");
  }
  try {
    const info = fstatSync(fd);
    const link = lstatSync(file);
    if (
      link.isSymbolicLink() ||
      link.ino !== info.ino ||
      link.dev !== info.dev ||
      info.size > 64 * 1024 ||
      !info.isFile() ||
      info.nlink !== 1 ||
      (process.platform !== "win32" &&
        (info.mode & 0o077 ||
          (typeof process.getuid === "function" && info.uid !== process.getuid())))
    )
      throw new Error("Bridge account configuration must be an owner-only regular file");
    const parsed = JSON.parse(readFileSync(fd, "utf8"));
    if (
      parsed?.version !== 1 ||
      !parsed.accounts ||
      typeof parsed.accounts !== "object" ||
      Array.isArray(parsed.accounts)
    )
      throw new Error();
    const out: Accounts = {};
    for (const [family, account] of Object.entries(parsed.accounts)) {
      if (
        (family !== "zai" && family !== "bigmodel") ||
        !validKey((account as { apiKey?: unknown })?.apiKey)
      )
        throw new Error();
      out[family] = { apiKey: (account as { apiKey: string }).apiKey };
    }
    return out;
  } catch {
    throw new Error("Invalid or insecure bridge account configuration");
  } finally {
    closeSync(fd);
  }
}

export async function saveBridgeAccount(
  family: CodingPlanFamily,
  apiKey: string,
  file = bridgeAccountsPath(),
): Promise<void> {
  if ((family !== "zai" && family !== "bigmodel") || !validKey(apiKey))
    throw new Error("Invalid Coding Plan account");
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch {
    throw new Error("Cannot create private bridge account directory");
  }
  // Exclusive lock makes concurrent read-modify-write fail explicitly rather
  // than silently losing the other family's key. No credential enters its name.
  const lock = `${file}.lock`;
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new Error("Account setup is already running or its lock is unavailable");
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const accounts = readBridgeAccounts(file);
    accounts[family] = { apiKey };
    await writeFile(temporary, JSON.stringify({ version: 1, accounts }) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, file);
  } catch {
    throw new Error("Cannot save bridge account configuration; existing accounts were preserved");
  } finally {
    await unlink(temporary).catch(() => undefined);
    await rmdir(lock).catch(() => undefined);
  }
}

/** Use the installed public catalog rather than inventing plan model IDs. */
export function codingPlanCatalog(family: CodingPlanFamily): {
  models: string[];
  baseURL: string;
  name: string;
} {
  // Resolve at consumption time: these modules form an existing discovery
  // cycle, so no filesystem/config reads happen during module initialization.
  const file = builtinTablePath();
  if (file) {
    try {
      const table = JSON.parse(readFileSync(file, "utf8"));
      const rule = table.config?.providerConfigRules?.providerRules?.find(
        (rule: { providerId?: string }) =>
          rule.providerId === `account:${family}-individual-coding-plan`,
      );
      const models: unknown = rule?.config?.builtinModelIds;
      if (
        Array.isArray(models) &&
        models.length &&
        models.every((model) => typeof model === "string" && model.length)
      )
        return {
          models,
          name: family === "zai" ? "Z.ai Coding Plan" : "BigModel Coding Plan",
          baseURL:
            family === "zai"
              ? "https://api.z.ai/api/anthropic"
              : "https://open.bigmodel.cn/api/anthropic",
        };
    } catch {
      /* Unsupported public catalog: report a safe setup error below. */
    }
  }
  throw new Error("Install a supported ZCode CLI and configure ZCODE_BIN before account setup");
}

/** Desktop entries retain their order; explicit bridge keys override only their plan. */
export function readCredentialConfig(legacyFile: string): CredentialConfig {
  const accounts = readBridgeAccounts();
  let config: CredentialConfig;
  try {
    config = JSON.parse(readFileSync(legacyFile, "utf8"));
  } catch (error) {
    if (!Object.keys(accounts).length)
      throw new Error("Cannot read Desktop credential configuration");
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Cannot read Desktop credential configuration");
    config = {};
  }
  const provider = { ...config.provider };
  for (const [family, account] of Object.entries(accounts)) {
    const catalog = codingPlanCatalog(family as CodingPlanFamily);
    provider[`builtin:${family}-coding-plan`] = {
      name: catalog.name,
      kind: "anthropic",
      enabled: true,
      options: { apiKey: account.apiKey, baseURL: catalog.baseURL },
      models: Object.fromEntries(catalog.models.map((model) => [model, {}])),
    };
  }
  return { ...config, provider };
}
