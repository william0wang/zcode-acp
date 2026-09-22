/**
 * Read/write for the desktop's personal provider config
 * (`~/.zcode/v2/provider_config.json`).
 *
 * This is where 3.12+ stores every user-added provider and model; the backend
 * registry reads it directly and absorbs external writes through a ~1s poll,
 * so a change here takes effect with NO restart and NO RPC
 * (`personal-provider-config-repository.ts`).
 *
 * What this module deliberately does NOT do:
 *
 *  - **Create or delete providers.** A provider rule carries credentials, an
 *    API protocol type and a model list, and getting it wrong yields a provider
 *    that fails at request time. That is a desktop-app (or hand-edit) job.
 *  - **Write `account:*` access.** The registry rejects `zhipu-account` access
 *    on personal rules outright — those providers come from the bundled table
 *    plus the account snapshot the bridge pushes. Writing one produces a file
 *    the backend refuses to load.
 *
 * Everything else the app's model page can do is here: enable/disable, rename,
 * add/remove a model on an existing provider, and edit a model's context
 * window and reasoning-level vocabulary.
 *
 * Canonical form matters: the file is written with 2-space indentation and NO
 * trailing newline, matching the app's own writer. A non-canonical file is
 * read fine but rewritten by the app on its next save, which would look like
 * our edit "reverting".
 */

import { readFile } from "node:fs/promises";

import { readJsonDocument, writeJsonAtomic } from "./atomic-write.js";
import { zcodePersonalProviderPath } from "../utils.js";

/** The only schema version the file format accepts. */
const SCHEMA_VERSION = 1;

/** Provider ids whose credentials may never appear in this file. */
const ACCOUNT_PROVIDER_PREFIX = "account:";

export interface ProviderModelConfig {
  enabled?: boolean;
  properties?: { contextWindow?: number };
  optionSpecs?: { reasoningLevel?: { values?: string[] } };
}

/** A model rule as stored, with its owning provider. */
export interface ModelRule {
  providerId: string;
  modelId: string;
  config: ProviderModelConfig;
}

export interface ProviderRule {
  providerId: string;
  providerName?: string;
  enabled?: boolean;
  config?: {
    access?: { type?: string; apiKey?: string };
    api?: { type?: string; baseUrl?: string };
    personalModelIds?: string[];
    modelOrder?: string[];
    [key: string]: unknown;
  };
}

export interface ProviderConfigFile {
  schemaVersion: number;
  config: {
    providerOrder?: string[];
    providerConfigRules: { providerRules: ProviderRule[] };
    modelConfigRules: {
      providerModelRules: ModelRule[];
      manualProviderModelRules: ModelRule[];
    };
    defaultModelSelection?: Record<string, unknown>;
  };
}

/**
 * Read the file, or return an empty canonical document when it is absent.
 *
 * @throws when the file exists but is malformed — the settings layer must
 *         refuse the write rather than base it on an empty document (the app's
 *         own reader degrades to an empty overlay while KEEPING the bad bytes,
 *         so silently overwriting would destroy what is still recoverable).
 */
export async function readProviderConfig(): Promise<ProviderConfigFile> {
  const file = zcodePersonalProviderPath();
  const doc = await readJsonDocument(file);
  if (doc === null) return emptyConfig();
  return normalize(doc);
}

function emptyConfig(): ProviderConfigFile {
  return {
    schemaVersion: SCHEMA_VERSION,
    config: {
      providerConfigRules: { providerRules: [] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  };
}

/**
 * Coerce a parsed document into the canonical shape.
 *
 * Unlike `cli/config.json` (an open document whose unknown keys are preserved),
 * this file's TOP level is strict — `{schemaVersion, config}` only, and an extra
 * key makes the backend registry reject the whole document. Unknown top-level
 * keys are therefore DROPPED, while everything inside `config` (including
 * unrecognized sub-keys on a provider rule) is carried through untouched.
 *
 * Missing containers are created so a hand-truncated file still round-trips
 * instead of producing an invalid document.
 */
function normalize(doc: Record<string, unknown>): ProviderConfigFile {
  const config = (doc.config ?? {}) as ProviderConfigFile["config"];
  const providerRules = Array.isArray(config.providerConfigRules?.providerRules)
    ? config.providerConfigRules.providerRules
    : [];
  const modelRules = config.modelConfigRules ?? {};
  const out: ProviderConfigFile = {
    schemaVersion: typeof doc.schemaVersion === "number" ? doc.schemaVersion : SCHEMA_VERSION,
    config: {
      providerConfigRules: { providerRules },
      modelConfigRules: {
        providerModelRules: Array.isArray(modelRules.providerModelRules)
          ? modelRules.providerModelRules
          : [],
        manualProviderModelRules: Array.isArray(modelRules.manualProviderModelRules)
          ? modelRules.manualProviderModelRules
          : [],
      },
    },
  };
  if (Array.isArray(config.providerOrder)) out.config.providerOrder = config.providerOrder;
  if (config.defaultModelSelection !== undefined) {
    out.config.defaultModelSelection = config.defaultModelSelection;
  }
  return out;
}

/**
 * Serialize in the app's canonical form: 2-space indentation, NO trailing
 * newline (the app's writer uses `JSON.stringify` directly). A trailing
 * newline is not an error to the reader, but the app rewrites the file to its
 * own canonical form on its next save, which makes our edit look reverted.
 */
export function encodeProviderConfig(doc: unknown): string {
  return JSON.stringify(doc, null, 2);
}

/** Structural self-check run before the bytes land. */
export function validateProviderConfig(doc: Record<string, unknown>): boolean | string {
  const file = doc as unknown as ProviderConfigFile;
  if (file.schemaVersion !== SCHEMA_VERSION) {
    return `schemaVersion must be ${SCHEMA_VERSION}`;
  }
  const config = file.config;
  if (typeof config !== "object" || config === null) return "config must be an object";
  const rules = config.providerConfigRules?.providerRules;
  if (!Array.isArray(rules)) return "config.providerConfigRules.providerRules must be an array";
  const seen = new Set<string>();
  for (const rule of rules) {
    if (!rule || typeof rule.providerId !== "string" || !rule.providerId) {
      return "every provider rule needs a non-empty providerId";
    }
    if (seen.has(rule.providerId)) return `duplicate providerId ${rule.providerId}`;
    seen.add(rule.providerId);
    // `zhipu-account` access is only valid on the bundled table; a personal
    // rule carrying it makes the registry reject the whole file.
    const accessType = (rule.config?.access as { type?: unknown } | undefined)?.type;
    if (accessType === "zhipu-account") {
      return `provider ${rule.providerId} may not declare zhipu-account access here`;
    }
  }
  const modelRules = config.modelConfigRules;
  if (typeof modelRules !== "object" || modelRules === null) {
    return "config.modelConfigRules must be an object";
  }
  for (const list of [modelRules.providerModelRules, modelRules.manualProviderModelRules]) {
    if (!Array.isArray(list)) return "model rule lists must be arrays";
    for (const rule of list) {
      if (!rule || typeof rule.providerId !== "string" || typeof rule.modelId !== "string") {
        return "every model rule needs providerId and modelId";
      }
    }
  }
  return true;
}

function assertNotAccountProvider(providerId: string): void {
  if (providerId.startsWith(ACCOUNT_PROVIDER_PREFIX)) {
    throw new Error(
      `provider ${providerId} is account-managed — its models come from the coding plan, not this file`,
    );
  }
}

/**
 * The single write path: validate, back up, rename.
 *
 * `mutator` runs INSIDE the file lock, against the freshly re-read document —
 * never against a snapshot taken before the lock was acquired. Reading outside
 * and passing the result in would silently drop whatever a concurrent writer
 * (a running desktop app, or another bridge process) landed in between, which
 * is exactly the invariant ADR-0026 exists to protect.
 */
async function saveProviderConfig(
  mutator: (doc: ProviderConfigFile) => void,
): Promise<ProviderConfigFile> {
  const file = zcodePersonalProviderPath();
  const { doc } = await writeJsonAtomic(
    file,
    (current) => {
      const next = normalize(current);
      mutator(next);
      return next as unknown as Record<string, unknown>;
    },
    {
      encode: encodeProviderConfig,
      validate: (d) => validateProviderConfig(d),
    },
  );
  return normalize(doc);
}

/**
 * Enable or disable a provider, and/or rename it.
 *
 * @param patch.enabled  `true`/`false` flips the rule's `enabled` flag; omit to
 *                       leave it alone.
 * @param patch.providerName renames the provider; omit to leave it alone.
 * @throws when the provider has no rule in this file (account-managed
 *         providers and bundled ones cannot be toggled here).
 */
export async function updateProvider(
  providerId: string,
  patch: { enabled?: boolean; providerName?: string },
): Promise<ProviderConfigFile> {
  assertNotAccountProvider(providerId);
  return saveProviderConfig((current) => {
    const rule = current.config.providerConfigRules.providerRules.find(
      (r) => r.providerId === providerId,
    );
    if (!rule) {
      throw new Error(
        `provider ${providerId} has no rule in provider_config.json — only providers declared here can be edited`,
      );
    }
    if (patch.enabled !== undefined) rule.enabled = patch.enabled;
    if (patch.providerName !== undefined) rule.providerName = patch.providerName;
  });
}

/**
 * Add a model to an existing provider, or update an existing rule.
 *
 * The model lands in `providerModelRules` (the list the app writes user models
 * to). A rule already present anywhere in either list is updated in place so a
 * repeated call is idempotent rather than duplicating.
 */
export async function upsertModel(
  providerId: string,
  modelId: string,
  patch: ProviderModelConfig,
): Promise<ProviderConfigFile> {
  assertNotAccountProvider(providerId);
  // Validate the patch before touching the lock: a rejected patch must not
  // consume a lock slot, and `mergeModelConfig` throws on a bad contextWindow.
  mergeModelConfig({}, patch);
  return saveProviderConfig((current) => {
    const rules = current.config.modelConfigRules;
    const existing =
      rules.providerModelRules.find((r) => r.providerId === providerId && r.modelId === modelId) ??
      rules.manualProviderModelRules.find(
        (r) => r.providerId === providerId && r.modelId === modelId,
      );
    if (existing) {
      existing.config = mergeModelConfig(existing.config, patch);
      return;
    }
    rules.providerModelRules.push({ providerId, modelId, config: mergeModelConfig({}, patch) });
    // Keep the provider's model list in step: a model absent from
    // personalModelIds never reaches the dropdown.
    const provider = current.config.providerConfigRules.providerRules.find(
      (r) => r.providerId === providerId,
    );
    const list = (provider?.config?.personalModelIds as string[] | undefined) ?? [];
    if (!list.includes(modelId)) {
      const nextList = [...list, modelId];
      if (provider) {
        provider.config = { ...(provider.config ?? {}), personalModelIds: nextList };
        // modelOrder is what the UI sorts by; append so the new model lands last.
        const order = (provider.config.modelOrder as string[] | undefined) ?? [];
        if (!order.includes(modelId)) provider.config.modelOrder = [...order, modelId];
      }
    }
  });
}

/** Remove a model rule from both lists. */
export async function removeModel(
  providerId: string,
  modelId: string,
): Promise<ProviderConfigFile> {
  let missing = false;
  const result = await saveProviderConfig((current) => {
    const rules = current.config.modelConfigRules;
    const before = rules.providerModelRules.length + rules.manualProviderModelRules.length;
    rules.providerModelRules = rules.providerModelRules.filter(
      (r) => !(r.providerId === providerId && r.modelId === modelId),
    );
    rules.manualProviderModelRules = rules.manualProviderModelRules.filter(
      (r) => !(r.providerId === providerId && r.modelId === modelId),
    );
    if (rules.providerModelRules.length + rules.manualProviderModelRules.length === before) {
      // Signal through a flag rather than throwing: throwing here would abort
      // the locked write and report a failure the client cannot act on.
      missing = true;
      return;
    }
    // Drop it from the provider's own lists too, or the dropdown keeps a model
    // the registry no longer knows.
    const provider = current.config.providerConfigRules.providerRules.find(
      (r) => r.providerId === providerId,
    );
    if (provider?.config) {
      for (const key of ["personalModelIds", "modelOrder"] as const) {
        const list = provider.config[key] as string[] | undefined;
        if (Array.isArray(list)) {
          provider.config[key] = list.filter((m) => m !== modelId);
        }
      }
    }
  });
  if (missing) throw new Error(`model ${modelId} has no rule for provider ${providerId}`);
  return result;
}

/**
 * Merge a patch into an existing model config.
 *
 * Only the three leaves the app's own manual-rule whitelist allows are
 * touched; everything else on the rule survives untouched. An explicit
 * `undefined` in the patch is a no-op, and `enabled: true` is recorded as the
 * absence of the flag (enabled is the default state).
 */
function mergeModelConfig(
  base: ProviderModelConfig,
  patch: ProviderModelConfig,
): ProviderModelConfig {
  const out: ProviderModelConfig = { ...base };
  if (patch.enabled === true) delete out.enabled;
  else if (patch.enabled === false) out.enabled = false;
  const ctx = patch.properties?.contextWindow;
  if (ctx !== undefined) {
    if (!(Number.isInteger(ctx) && ctx > 0)) {
      throw new Error("contextWindow must be a positive integer");
    }
    out.properties = { ...(out.properties ?? {}), contextWindow: ctx };
  }
  const values = patch.optionSpecs?.reasoningLevel?.values;
  if (values !== undefined) {
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error("reasoningLevel.values must be a non-empty array");
    }
    if (new Set(values).size !== values.length) {
      throw new Error("reasoningLevel.values must not repeat");
    }
    out.optionSpecs = { ...(out.optionSpecs ?? {}), reasoningLevel: { values: [...values] } };
  }
  return out;
}

/** Read the raw file text (for the settings snapshot). Absent → null. */
export async function readProviderConfigRaw(): Promise<string | null> {
  try {
    return await readFile(zcodePersonalProviderPath(), "utf8");
  } catch {
    return null;
  }
}

/** The canonical bytes a document would be written as. */
export function canonicalBytes(doc: ProviderConfigFile): string {
  return encodeProviderConfig(doc);
}
