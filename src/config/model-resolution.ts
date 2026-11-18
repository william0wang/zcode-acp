/**
 * Unified inbound model-value resolution (#403).
 *
 * Model values arrive from several dialects and eras: the bridge's own
 * `providerId\modelId` configOption encoding, the `custom:<urlencoded>:<model>`
 * agent-definition spelling, a `/`-separated provider ref (the string form the
 * backend itself parses, provider-registry-selection.ts), a legacy bare
 * modelId, and provider ids in either the config dialect (`builtin:…`) or the
 * registry dialect (`account:…`). The backend registry validates selections by
 * EXACT string match on (providerId, modelId) — no alias resolution exists at
 * that layer — so every inbound value must be normalized against a registry
 * snapshot before `session/setModel`, or a stale id ("GLM-5.3" from a frozen
 * config.json, a `builtin:`-prefixed id from an older advertisement) fails with
 * "Provider Registry 中不存在 Model" and clients abort the session open
 * (observed with T3 Code, issue #403).
 *
 * Resolution is deterministic only: separator/dialect/case folding, mirroring
 * upstream's frozen one-way maps (`legacy-model-provider-identity.ts`,
 * `official-glm-model-id.ts`). No cross-family substitution — a provider id
 * that folds to nothing in the snapshot fails rather than silently billing a
 * different plan family (upstream explicitly declines such mapping:
 * session-model-unavailable-admission.md "不在范围").
 */

import { accountProviderIdFor, configProviderIdFor } from "./account-provider.js";

/** Structural shape of a `server.modelAvailability` entry (registry dialect). */
export interface RegistryModelEntry {
  providerId?: string;
  modelId?: string;
}

export interface ResolvedModelTarget {
  /** Registry dialect (`account:…` for coding plans). */
  providerId: string;
  modelId: string;
  /** How the target was found — "unverified" means no snapshot was available. */
  via: "exact" | "dialect" | "case-fold" | "unique" | "unverified";
}

export type ModelResolution =
  { ok: true; target: ResolvedModelTarget } | { ok: false; reason: string };

export interface ParsedModelRef {
  /** Undefined for a legacy bare modelId (no provider qualification). */
  providerId?: string;
  modelId: string;
  /** True for `custom:`/`\`/`/` qualified forms — a bare modelId is not encoded. */
  encoded: boolean;
}

/**
 * Split an inbound model value into its syntactic parts. Pure syntax — no
 * config files, no snapshot. Extends `parseModelValue` (options.ts) with the
 * `/`-separated provider ref dialect; that function's bare-id branch resolves
 * against local config and stays where it is.
 */
export function parseModelRefValue(value: string): ParsedModelRef {
  const custom = /^custom:([^:]+):(.+)$/.exec(value);
  if (custom) {
    try {
      return { providerId: decodeURIComponent(custom[1]!), modelId: custom[2]!, encoded: true };
    } catch {
      // malformed encoding — fall through to the legacy spellings
    }
  }
  const backslash = value.indexOf("\\");
  if (backslash > 0) {
    return {
      providerId: value.slice(0, backslash),
      modelId: value.slice(backslash + 1),
      encoded: true,
    };
  }
  // `/`-separated provider ref (the backend's own string form): only when the
  // prefix looks like a provider id (contains ":"), so a bare modelId that
  // merely contains a slash is not torn apart.
  const slash = value.indexOf("/");
  if (slash > 0 && value.slice(0, slash).includes(":")) {
    return { providerId: value.slice(0, slash), modelId: value.slice(slash + 1), encoded: true };
  }
  return { modelId: value, encoded: false };
}

/** Provider id candidates for a parsed ref: the id itself plus both dialects. */
function providerCandidates(providerId: string): string[] {
  const out: string[] = [];
  for (const candidate of [
    providerId,
    accountProviderIdFor(providerId),
    configProviderIdFor(providerId),
  ]) {
    if (candidate && !out.includes(candidate)) out.push(candidate);
  }
  return out;
}

function lower(s: string): string {
  return s.toLowerCase();
}

/**
 * Resolve an inbound model value against a registry snapshot.
 *
 * Order per provider candidate: exact model id, then case-folded (mirrors
 * upstream `normalizeOfficialGlmModelId` without freezing a local model list —
 * the snapshot itself is the vocabulary). A bare modelId resolves only when it
 * names exactly ONE model across the snapshot. Without a snapshot, a provider-
 * qualified ref passes through dialect-folded ("unverified" — the backend
 * stays the final authority); a bare id cannot resolve.
 */
export function resolveModelTarget(
  value: string,
  snapshot: readonly RegistryModelEntry[] | undefined,
): ModelResolution {
  const parsed = parseModelRefValue(value);
  const snapshotPresent = Array.isArray(snapshot) && snapshot.length > 0;
  if (!snapshotPresent) {
    if (parsed.providerId) {
      return {
        ok: true,
        target: {
          providerId: accountProviderIdFor(parsed.providerId),
          modelId: parsed.modelId,
          via: "unverified",
        },
      };
    }
    return { ok: false, reason: `bare model id "${value}" with no registry snapshot` };
  }

  if (parsed.providerId) {
    const candidates = providerCandidates(parsed.providerId);
    for (const pid of candidates) {
      for (const entry of snapshot) {
        if (entry.providerId === pid && entry.modelId === parsed.modelId) {
          return {
            ok: true,
            target: {
              providerId: pid,
              modelId: parsed.modelId,
              via: pid === parsed.providerId ? "exact" : "dialect",
            },
          };
        }
      }
    }
    for (const pid of candidates) {
      for (const entry of snapshot) {
        if (entry.providerId === pid && lower(entry.modelId ?? "") === lower(parsed.modelId)) {
          return {
            ok: true,
            target: { providerId: pid, modelId: entry.modelId!, via: "case-fold" },
          };
        }
      }
    }
    const tried = candidates.join(", ");
    return {
      ok: false,
      reason: `"${value}" matches no model in the session registry (providers tried: ${tried})`,
    };
  }

  // Bare model id: exact match first, then case-folded; unique provider only.
  for (const fold of [false, true]) {
    const hits = snapshot.filter((e) =>
      e.providerId && e.modelId
        ? fold
          ? lower(e.modelId) === lower(parsed.modelId)
          : e.modelId === parsed.modelId
        : false,
    );
    const providers = new Set(hits.map((e) => e.providerId!));
    if (providers.size === 1) {
      const hit = hits[0]!;
      return {
        ok: true,
        target: {
          providerId: hit.providerId!,
          modelId: hit.modelId!,
          via: fold ? "case-fold" : "unique",
        },
      };
    }
  }
  return {
    ok: false,
    reason: `bare model id "${value}" is not uniquely present in the session registry`,
  };
}
