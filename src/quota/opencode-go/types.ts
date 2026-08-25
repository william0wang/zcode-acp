/**
 * Type definitions for the Opencode Go subscription usage feature.
 *
 * The `zcode-acp quota` CLI queries the opencode.ai web dashboard (there is no
 * JSON API yet) by scraping the SolidJS SSR hydration payload embedded in
 * `https://opencode.ai/workspace/<id>/go`. Usage is split into three windows:
 * rolling (5h), weekly (7d), monthly (30d). Each window carries only a
 * server-provided `usagePercent` and a relative `resetInSec` countdown.
 */

/** One usage window — both fields are server-provided. */
export interface GoWindow {
  /** Used percentage in [0, 100], already computed server-side. */
  usagePercent: number;
  /** Seconds until this window resets (relative countdown, not a timestamp). */
  resetInSec: number;
}

/**
 * Result of querying Opencode Go usage — a 4-state sum type.
 *
 * `not_configured` is distinct from `unavailable`: the CLI uses it to silently
 * skip the Go section in default (dual-platform) mode when the user has not
 * supplied credentials, rather than printing an error.
 */
export type GoQueryResult =
  | {
      kind: "success";
      rolling: GoWindow;
      weekly: GoWindow;
      /** Monthly window is optional — present when the dashboard exposes it. */
      monthly: GoWindow | null;
      /** Epoch ms of the fetch, used to drive the live countdown in the CLI. */
      fetchedAt: number;
    }
  | { kind: "not_configured" }
  | { kind: "auth_error" }
  | { kind: "unavailable" };

/** The three window keys, in display order. */
export type GoWindowKey = "rolling" | "weekly" | "monthly";

/** Raw dashboard fetch result — HTML + the final (post-redirect) URL. */
export interface GoDashboardResponse {
  status: number;
  text: string;
  /** Final URL after redirects; used to detect redirect-to-login. */
  finalUrl: string;
}
