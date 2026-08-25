/**
 * Remote access configuration from environment variables.
 *
 * Remote access is opt-in via ZCODE_ACP_REMOTE=1 and REQUIRES a token — the
 * endpoint is expected to sit behind a public tunnel (Cloudflare Tunnel, frp),
 * so "loopback-only" is never a safe assumption here. A missing token disables
 * the feature with a warning instead of failing the bridge: the stdio link to
 * the editor must keep working no matter what.
 *
 * Variables:
 *   ZCODE_ACP_REMOTE=1            enable the remote endpoint (gate)
 *   ZCODE_ACP_REMOTE_TOKEN=<s>    auth token (mandatory when enabled)
 *   ZCODE_ACP_HUB_PORT=8377       hub's fixed port (the one a tunnel maps)
 *   ZCODE_ACP_HUB_HOST=127.0.0.1  hub bind address (e.g. 0.0.0.0 for a
 *                                 containerized tunnel agent)
 *   ZCODE_ACP_REMOTE_PORT=8378    bridge endpoint start port (auto-increment
 *                                 when taken; loopback only)
 */

import { warn } from "../utils.js";

export interface RemoteConfig {
  token: string;
  hubPort: number;
  hubHost: string;
  bridgePort: number;
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

/** Parse remote config; null = disabled (or misconfigured → warned). */
export function parseRemoteConfig(env: NodeJS.ProcessEnv = process.env): RemoteConfig | null {
  const gate = (env.ZCODE_ACP_REMOTE ?? "").trim().toLowerCase();
  if (!["1", "true", "yes", "on"].includes(gate)) return null;
  const token = (env.ZCODE_ACP_REMOTE_TOKEN ?? "").trim();
  if (!token) {
    warn(
      "remote: ZCODE_ACP_REMOTE is enabled but ZCODE_ACP_REMOTE_TOKEN is missing — " +
        "remote access disabled (stdio unaffected)",
    );
    return null;
  }
  return {
    token,
    hubPort: parsePort(env.ZCODE_ACP_HUB_PORT, DEFAULT_HUB_PORT, "ZCODE_ACP_HUB_PORT"),
    hubHost: (env.ZCODE_ACP_HUB_HOST ?? "").trim() || DEFAULT_HUB_HOST,
    bridgePort: parsePort(env.ZCODE_ACP_REMOTE_PORT, DEFAULT_BRIDGE_PORT, "ZCODE_ACP_REMOTE_PORT"),
  };
}

/** Parse hub-side config for the standalone hub entry (`zcode-acp hub`). */
export function parseHubConfig(env: NodeJS.ProcessEnv = process.env): RemoteConfig | null {
  const token = (env.ZCODE_ACP_REMOTE_TOKEN ?? "").trim();
  if (!token) {
    warn("hub: ZCODE_ACP_REMOTE_TOKEN is required — refusing to start without auth");
    return null;
  }
  return {
    token,
    hubPort: parsePort(env.ZCODE_ACP_HUB_PORT, DEFAULT_HUB_PORT, "ZCODE_ACP_HUB_PORT"),
    hubHost: (env.ZCODE_ACP_HUB_HOST ?? "").trim() || DEFAULT_HUB_HOST,
    bridgePort: parsePort(env.ZCODE_ACP_REMOTE_PORT, DEFAULT_BRIDGE_PORT, "ZCODE_ACP_REMOTE_PORT"),
  };
}
