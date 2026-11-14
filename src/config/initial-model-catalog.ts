import type { ZcodeBackend } from "../backend/client.js";
import type { ZcodeCreateResult } from "../backend/types.js";
import type { ZcodeAcpServer } from "../server.js";
import { buildProviderRegistry } from "./provider-registry.js";
import { pushAccountProviderConfig } from "./account-provider.js";
import { initialSessionMode } from "./settings.js";
import { deferredProbeCapabilityVerified } from "./deferred-probe-capability.js";
import { resolveZcodeCommand } from "../backend/resolve.js";

const DEADLINE_MS = 15000;
// Includes timed-out work until startup, requests and process termination settle.
// A stuck operation deliberately retains the slot rather than spawning unbounded children.
let probeActive = false;

/** Each probe owns its backend: a timed-out create can never leak a resident
 * runtime into the bridge's shared process, even if its reply arrives late. */
export async function probeInitialModelCatalog(
  cwd: string,
  createServer: () => Promise<ZcodeAcpServer> = async () => {
    const { ZcodeAcpServer } = await import("../server.js");
    return new ZcodeAcpServer({ catalogProbe: true });
  },
  deadlineMs = DEADLINE_MS,
): Promise<ZcodeCreateResult | null> {
  // Never even start a backend without an authoritative non-mutating proof.
  // Some old servers accept unknown fields and persist the probe immediately.
  if (!deferredProbeCapabilityVerified(resolveZcodeCommand({ catalogProbe: true }))) return null;
  if (probeActive) return null;
  probeActive = true;
  let expired = false;
  let backend: ZcodeBackend | undefined;
  let server: ZcodeAcpServer | undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    const child = backend ?? server?.backend ?? undefined;
    if (child && !closing) closing = child.close().catch(() => {});
    return closing;
  };
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      void close();
      resolve(null);
    }, deadlineMs);
  });
  const work = (async (): Promise<ZcodeCreateResult | null> => {
    try {
      const activeServer = await createServer();
      server = activeServer;
      if (expired) return null;
      activeServer.sessionCwds?.set("catalog-probe", cwd);
      backend = await activeServer.ensureBackend();
      if (expired) return null;
      const workspace = { workspacePath: cwd, workspaceKey: cwd };
      try {
        await pushAccountProviderConfig(backend, () => activeServer.nextId());
        if (expired) return null;
        const registry = buildProviderRegistry();
        if (registry.providers.length) {
          await backend.request(
            activeServer.nextId(),
            "workspace/updateProviderRegistry",
            { workspace, registry },
            10000,
          );
        }
      } catch {
        // Match ordinary session creation's best-effort registry sync.
      }
      if (expired) return null;
      const response = await backend.request(
        activeServer.nextId(),
        "session/create",
        {
          workspace,
          mode: initialSessionMode(),
          persistence: "deferred",
        },
        deadlineMs,
      );
      if (expired || response.error) return null;
      const result = response.result as ZcodeCreateResult | undefined;
      const sid = result?.session?.sessionId;
      if (typeof sid !== "string" || !sid) return null;
      // Some create snapshots carry availability but omit the selected model.
      // Read the same resident session before closing it; never guess a current
      // value from the available list or local configuration.
      if (
        result?.settings?.model &&
        (!result.settings.model.current?.providerId || !result.settings.model.current?.modelId)
      ) {
        const read = await backend.request(
          activeServer.nextId(),
          "session/read",
          { sessionId: sid },
          3000,
        );
        const current = (read.result as ZcodeCreateResult | undefined)?.settings?.model?.current;
        if (current?.providerId && current.modelId) {
          result.settings.model.current = current;
        }
      }
      // Explicitly release the runtime before killing the isolated process.
      await backend.request(activeServer.nextId(), "session/close", { sessionId: sid }, 1000);
      return expired ? null : (result ?? null);
    } catch {
      return null;
    } finally {
      try {
        await close();
        const proc = backend?.proc;
        if (proc?.pid && proc.exitCode === null && proc.signalCode === null) {
          await new Promise<void>((resolve) => proc.once("exit", () => resolve()));
        }
      } finally {
        probeActive = false;
      }
    }
  })();
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
