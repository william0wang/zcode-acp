/**
 * Quota threshold push warnings (push spec §5.7, requested 2026-10-01):
 * the 5-hour and weekly windows each notify ONCE per tier — 60% used, 80%
 * used, 90% used, 95% used, 98% used, exhausted — edge-triggered on a
 * refresh DISCOVERING the first crossing (never level-triggered, precision
 * explicitly not required).
 *
 * Every fresh `queryQuota()` fetch funnels through here (the martty dock
 * refresher's 60s cadence + turn-end forceRefresh, the hub's dock cache,
 * `/quota`, the settings REST routes), so wherever quota data materializes,
 * thresholds are watched. A drop below 60 re-arms the tiers (new window,
 * reset card, weekly rollover).
 *
 * The per-key highest-notified tier is PERSISTED next to the user config
 * (`quota-push-state.json`): the hub idle-exits and re-spawns, and bridges
 * restart — without persistence every rebirth while usage sits above a tier
 * would re-push it, and a hub + bridge pair could double-push one crossing.
 * The state advances even when the push itself is switched off or
 * suppressed, so re-enabling never replays old crossings. Everything here is
 * fire-and-forget from the caller's view: failures warn, never throw.
 */

import path from "node:path";

import { userConfigPath } from "../config/user-config.js";
import { pushActive } from "../push/config.js";
import { pushQuotaWarning } from "../push/push.js";
import { readJsonDocument, writeJsonAtomic } from "../settings/atomic-write.js";
import { warn } from "../utils.js";
import type { QuotaItem, QuotaResult } from "./types.js";

/** Windows that count as budget alarms (keys from parse.ts). */
const WATCHED_KEYS = new Set(["token_5h", "token_week"]);

/** Notify tiers in percent: 60 / 80 / 90 / 95 / 98 / exhausted (100). */
const TIERS = [60, 80, 90, 95, 98, 100] as const;

/** Window display name for the push title. */
function windowName(item: QuotaItem): string {
  return item.key === "token_week" ? "weekly" : item.label.toLowerCase();
}

/** Highest tier crossed by a used percentage (0 = below all). */
export function quotaTier(usedPercent: number): number {
  let tier = 0;
  for (const t of TIERS) if (usedPercent >= t) tier = t;
  return tier;
}

function statePath(): string {
  return path.join(path.dirname(userConfigPath()), "quota-push-state.json");
}

/** In-memory mirror of the persisted tiers, loaded once per process. */
let state: Map<string, number> | null = null;

async function loadState(): Promise<Map<string, number>> {
  if (state) return state;
  const map = new Map<string, number>();
  try {
    const doc = await readJsonDocument(statePath());
    const items = (doc ?? {})["items"];
    if (typeof items === "object" && items !== null && !Array.isArray(items)) {
      for (const key of WATCHED_KEYS) {
        const v = (items as Record<string, unknown>)[key];
        if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100) {
          map.set(key, v);
        }
      }
    }
  } catch {
    // Absent or unreadable — starts re-armed; never fatal.
  }
  state = map;
  return map;
}

async function persist(map: Map<string, number>): Promise<void> {
  try {
    await writeJsonAtomic(statePath(), () => ({ items: Object.fromEntries(map) }), {
      skipBackup: true,
    });
  } catch (e) {
    warn(`quota-thresholds: state persist failed (${e instanceof Error ? e.message : String(e)})`);
  }
}

/**
 * Check one fresh quota result against the persisted tiers and push each
 * newly-crossed tier once. Callers fire-and-forget this; it never throws.
 */
export async function checkQuotaThresholds(result: QuotaResult): Promise<void> {
  // Without push there is nothing to notify and no state worth maintaining —
  // a later activation starts re-armed instead of replaying old crossings.
  if (!pushActive()) return;
  if (result.kind !== "success") return;
  const st = await loadState();
  let dirty = false;
  for (const item of result.items) {
    if (!WATCHED_KEYS.has(item.key)) continue;
    const tier = quotaTier(item.usedPercent);
    const prev = st.get(item.key) ?? 0;
    if (tier === 0) {
      // Usage dropped below the first tier — new window / reset card: re-arm.
      if (prev !== 0) {
        st.delete(item.key);
        dirty = true;
      }
      continue;
    }
    if (tier <= prev) continue;
    st.set(item.key, tier);
    dirty = true;
    const name = windowName(item);
    pushQuotaWarning({
      kind: "quota",
      title:
        tier === 100
          ? `${name} quota exhausted`
          : `${name} quota ${Math.round(item.usedPercent)}% used`,
      body: item.nextResetTime
        ? `resets ${new Date(item.nextResetTime).toLocaleString()}`
        : undefined,
    });
  }
  if (dirty) await persist(st);
}

/** Test hook: forget the in-memory mirror (the disk state stays). */
export function resetQuotaThresholdsForTest(): void {
  state = null;
}
