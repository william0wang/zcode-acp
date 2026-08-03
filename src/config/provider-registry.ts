/**
 * Build a provider-registry payload for `workspace/updateProviderRegistry`.
 *
 * The V4 backend doesn't auto-load providers from config.json — the host must
 * push them via this RPC after `session/create`, otherwise third-party
 * providers fail with `provider_not_configured` (misclassified as a network
 * error after turn-retry exhausts). ZCode app does this from its
 * ModelProviderService; the bridge mirrors it by reading config.json directly.
 *
 * Provider element schema (from the backend's `j7t` converter in zcode.cjs):
 *   { providerId, apiKey?, apiKeyRequired?, apiFormat?, baseURL?, headers?,
 *     kind?, label?, models?, providerOptions?, source? }
 * `apiKey` is a discriminated union `{source:"inline", value:"<key>"}` — a
 * bare string is rejected. `apiFormat` maps from `kind`:
 *   anthropic → "anthropic-messages", openai-compatible → "openai-chat-completions".
 */

import { readFileSync } from "node:fs";

import { ZCODE_CREDS_PATH, log } from "../utils.js";

/** A provider's raw entry in config.json (`provider.<providerId>`). */
interface ProviderEntry {
  name?: string;
  kind?: string;
  enabled?: boolean;
  source?: string;
  options?: { baseURL?: string; apiKey?: string; apiKeyRequired?: boolean };
  models?: Record<string, unknown>;
}

interface ConfigShape {
  provider?: Record<string, ProviderEntry>;
}

/** Registry payload for `workspace/updateProviderRegistry`. */
export interface ProviderRegistryPayload {
  providers: ReadonlyArray<Record<string, unknown>>;
  generatedAt: number;
  revision: string;
}

/** Map config.json `kind` → backend `apiFormat`. */
function apiFormatForKind(kind: string | undefined): string | undefined {
  if (!kind) return undefined;
  if (kind.includes("anthropic")) return "anthropic-messages";
  if (kind.includes("openai")) return "openai-chat-completions";
  return undefined;
}

/** Build a single provider element from a config.json entry. */
function buildProviderElement(providerId: string, p: ProviderEntry): Record<string, unknown> {
  // models MUST be an array of {modelId} — the backend's strict schema rejects
  // the object form ({modelId: {...}}) that config.json uses. Only the id is
  // required; context limits live in the backend's own model catalog.
  const models = Object.keys(p.models ?? {}).map((modelId) => ({ modelId }));
  const el: Record<string, unknown> = {
    providerId,
    kind: p.kind,
    apiFormat: apiFormatForKind(p.kind),
    baseURL: p.options?.baseURL,
    label: p.name ?? providerId,
    models,
    source: p.source ?? "custom",
  };
  if (p.options?.apiKeyRequired !== undefined) {
    el.apiKeyRequired = p.options.apiKeyRequired;
  }
  // apiKey MUST be the inline union shape — a bare string is rejected by the
  // backend's strict schema. When present, the backend stores it into its
  // session secrets and resolves auth from there (no separate headers callback
  // needed for these providers).
  if (p.options?.apiKey) {
    el.apiKey = { source: "inline", value: p.options.apiKey };
  }
  // Omit undefined values so the payload stays clean.
  for (const k of Object.keys(el)) {
    if (el[k] === undefined) delete el[k];
  }
  return el;
}

/**
 * Build the registry payload from ALL providers in config.json.
 *
 * Unlike `loadAllModels` (dropdown, enabled-only), the registry pushes every
 * configured provider so the backend recognises any of them when a session
 * switches to it. The backend applies its own enable/availability rules.
 */
export function buildProviderRegistry(): ProviderRegistryPayload {
  const cfg = JSON.parse(readFileSync(ZCODE_CREDS_PATH, "utf8")) as ConfigShape;
  const providers = Object.entries(cfg.provider ?? {}).map(([pid, p]) =>
    buildProviderElement(pid, p ?? {}),
  );
  const generatedAt = Date.now();
  // revision is a content hash; the backend skips unchanged revisions. A stable
  // JSON hash over provider ids+kinds+baseURLs is enough — apiKey changes are
  // rare and a generatedAt bump alone won't force re-apply (revision is the gate).
  const revision = hashRevision(providers);
  log(
    `provider-registry: built ${providers.length} provider(s) ` +
      `(ids: ${providers.map((p) => p.providerId).join(", ") || "none"})`,
  );
  return { providers, generatedAt, revision };
}

/** Stable short hash over provider ids + kind + baseURL (revision gate). */
function hashRevision(providers: ReadonlyArray<Record<string, unknown>>): string {
  const sig = providers
    .map((p) => `${p.providerId}|${p.kind ?? ""}|${p.baseURL ?? ""}`)
    .sort()
    .join("\n");
  // FNV-1a 32-bit → hex; cheap, dependency-free, stable.
  let h = 0x811c9dc5;
  for (let i = 0; i < sig.length; i++) {
    h ^= sig.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
