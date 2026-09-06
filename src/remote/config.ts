/**
 * Remote access configuration: user config file first, env fallback.
 *
 * Remote access is opt-in and REQUIRES a token — the endpoint is expected to
 * sit behind a public tunnel (Cloudflare Tunnel, frp), so "loopback-only" is
 * never a safe assumption here. A missing token disables the feature with a
 * warning instead of failing the bridge: the stdio link to the editor must
 * keep working no matter what.
 *
 * Sources, in priority order (per field):
 *   1. ~/.config/zcode-acp/config.json `remote` section (XDG_CONFIG_HOME
 *      aware) — the authoritative, launch-context-independent source. The
 *      hub daemon is idle-exited and re-spawned by arbitrary bridges, so its
 *      birth env rotates; user preference must not.
 *   2. Environment variables (unchanged semantics — setups without a file
 *      keep working, and env fills any field the file leaves unset):
 *     ZCODE_ACP_REMOTE=1            enable the remote endpoint (gate)
 *     ZCODE_ACP_REMOTE_TOKEN=<s>    auth token (mandatory when enabled)
 *     ZCODE_ACP_HUB_PORT=8377       hub's fixed port (the one a tunnel maps)
 *     ZCODE_ACP_HUB_HOST=127.0.0.1  hub bind address (e.g. 0.0.0.0 for a
 *                                   containerized tunnel agent)
 *     ZCODE_ACP_REMOTE_PORT=8378    bridge endpoint start port (auto-increment
 *                                   when taken; loopback only)
 *     ZCODE_ACP_HUB_TERMINAL=0      disable the visible-terminal incubation
 *     ZCODE_ACP_HUB_TERMINAL_APP=<name>   terminal app for the TUI window
 *     ZCODE_ACP_HUB_TERMINAL_COMMAND=<sh> shell command template ({script})
 *   3. Built-in defaults.
 *
 * Process-role plumbing stays env-only by design (never file-configurable):
 *   ZCODE_ACP_REMOTE_ORIGIN=serve  registration origin override (ADR-0016)
 *   ZCODE_ACP_REMOTE_PIN_CWD=1     pin session roots to the process cwd
 *   ZCODE_ACP_RESUME_SESSION=<id>  per-request boot-resume target (ADR-0017)
 */

import { loadUserConfig, type TerminalPrefs } from "../config/user-config.js";
import { warn } from "../utils.js";

export interface RemoteConfig {
  token: string;
  hubPort: number;
  hubHost: string;
  bridgePort: number;
  /**
   * Who this bridge serves: "editor" (spawned by an editor over stdio) or
   * "serve" (headless, hub-spawned for remote session-create, ADR-0014).
   * Rides the registration heartbeat; the hub uses it to dedupe headless
   * instances per workspace and label them for remote clients.
   */
  origin: "editor" | "serve";
  /**
   * Pin every session root to the process cwd (serveMode for the bridge).
   * Set by the hub when it incubates a REPL in a visible terminal
   * (ADR-0016): the REPL bridge is a stdio bridge by lifecycle, but its
   * sessions must obey ADR-0014's whitelist semantics — a remote client
   * must not steer them into arbitrary directories.
   */
  pinCwd: boolean;
}

export const DEFAULT_HUB_PORT = 8377;
export const DEFAULT_BRIDGE_PORT = 8378;
export const DEFAULT_HUB_HOST = "127.0.0.1";

function parsePort(raw: string | undefined, fallback: number, envName: string): number {
  if (!raw) return fallback;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    warn(`remote: invalid ${envName}="${raw}", falling back to ${fallback}`);
    return fallback;
  }
  return port;
}

/** Shared file>env merge for token/ports/host (already validated by the loader). */
function mergeCommon(env: NodeJS.ProcessEnv): {
  token: string;
  hubPort: number;
  hubHost: string;
  bridgePort: number;
} {
  const file = loadUserConfig(env).remote ?? {};
  return {
    token: file.token ?? (env.ZCODE_ACP_REMOTE_TOKEN ?? "").trim(),
    hubPort:
      file.hubPort ?? parsePort(env.ZCODE_ACP_HUB_PORT, DEFAULT_HUB_PORT, "ZCODE_ACP_HUB_PORT"),
    hubHost: file.hubHost ?? ((env.ZCODE_ACP_HUB_HOST ?? "").trim() || DEFAULT_HUB_HOST),
    bridgePort:
      file.bridgePort ??
      parsePort(env.ZCODE_ACP_REMOTE_PORT, DEFAULT_BRIDGE_PORT, "ZCODE_ACP_REMOTE_PORT"),
  };
}

/** Parse remote config; null = disabled (or misconfigured → warned). */
export function parseRemoteConfig(env: NodeJS.ProcessEnv = process.env): RemoteConfig | null {
  const file = loadUserConfig(env).remote ?? {};
  // Gate: the file is authoritative when it says anything; env decides only
  // when the file is silent (an explicit `enabled: false` wins over env =1).
  const enabled =
    file.enabled !== undefined
      ? file.enabled
      : ["1", "true", "yes", "on"].includes((env.ZCODE_ACP_REMOTE ?? "").trim().toLowerCase());
  if (!enabled) return null;
  const { token, hubPort, hubHost, bridgePort } = mergeCommon(env);
  if (!token) {
    warn(
      "remote: enabled but no token (config file or ZCODE_ACP_REMOTE_TOKEN) — " +
        "remote access disabled (stdio unaffected)",
    );
    return null;
  }
  return {
    token,
    hubPort,
    hubHost,
    bridgePort,
    origin: (env.ZCODE_ACP_REMOTE_ORIGIN ?? "").trim() === "serve" ? "serve" : "editor",
    pinCwd: (env.ZCODE_ACP_REMOTE_PIN_CWD ?? "").trim() === "1",
  };
}

/** Parse hub-side config for the standalone hub entry (`zcode-acp hub`). */
export function parseHubConfig(env: NodeJS.ProcessEnv = process.env): RemoteConfig | null {
  const { token, hubPort, hubHost, bridgePort } = mergeCommon(env);
  if (!token) {
    warn("hub: no token (config file or ZCODE_ACP_REMOTE_TOKEN) — refusing to start without auth");
    return null;
  }
  return {
    token,
    hubPort,
    hubHost,
    bridgePort,
    origin: "editor",
    pinCwd: false,
  };
}

/**
 * Terminal incubation preferences for the hub (ADR-0016), merged file > env.
 * Read LIVE by the hub at every incubation so editing the file takes effect
 * without a hub restart — the hub outlives the shells that configured it.
 */
export function remoteTerminalPrefs(env: NodeJS.ProcessEnv = process.env): TerminalPrefs {
  const file = loadUserConfig(env).remote?.terminal ?? {};
  const app = file.app ?? ((env.ZCODE_ACP_HUB_TERMINAL_APP ?? "").trim() || undefined);
  const command =
    file.command ?? ((env.ZCODE_ACP_HUB_TERMINAL_COMMAND ?? "").trim() || undefined);
  const enabled =
    file.enabled ?? !["0", "false", "off"].includes(
      (env.ZCODE_ACP_HUB_TERMINAL ?? "").trim().toLowerCase(),
    );
  return { enabled, ...(app ? { app } : {}), ...(command ? { command } : {}) };
}
