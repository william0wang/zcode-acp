/**
 * Best-effort POST /api/upgrade poke at the local hub — the "updater owns
 * the restart" half of the staleness design (apt postinst convention): the
 * process that just changed the code on disk tells the running daemon to
 * re-check itself. The hub still makes its own decision (content fingerprint
 * / version / mtime comparison) — this script never forces anything.
 *
 * Run from `pnpm build` (fresh local rebuild) and the npm postinstall hook
 * (a consumer upgrading the package). Every failure is silent by design:
 * no hub running, no token, no remote config — nothing to do, exit 0.
 */

import process from "node:process";

import { loadUserConfig } from "../config/user-config.js";

function quietHubTarget(env: NodeJS.ProcessEnv): { token: string; port: number } | null {
  const file = loadUserConfig(env).remote ?? {};
  const token = file.token ?? (env.ZCODE_ACP_REMOTE_TOKEN ?? "").trim();
  if (!token) return null;
  const port = file.hubPort ?? (Number.parseInt(env.ZCODE_ACP_HUB_PORT ?? "", 10) || 8377);
  return { token, port };
}

async function main(): Promise<void> {
  const target = quietHubTarget(process.env);
  if (!target) return; // no token configured — nothing to poke
  try {
    const res = await fetch(`http://127.0.0.1:${target.port}/api/upgrade`, {
      method: "POST",
      headers: { Authorization: `Bearer ${target.token}` },
      signal: AbortSignal.timeout(3000),
    });
    // Any answer (restart decision or refusal) is the hub's call — even a
    // 401 just means a token rotation the hub itself will resolve.
    if (!res.ok) return;
  } catch {
    /* hub not running / not reachable — nothing to upgrade */
  }
}

void main().finally(() => process.exit(0));
