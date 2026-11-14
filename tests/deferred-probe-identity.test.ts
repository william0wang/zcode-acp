import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  auditedBundleMatches,
  boundDeferredProbeCommand,
  catalogProbeDiagnostic,
  deferredProbeCapabilityVerified,
} from "../src/config/deferred-probe-capability.js";

const entry = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const oldDigest = "26785f28ab8fb9f8b0f3821f2bf71d294f4d0b8bf28108785292f86c7e14090d";
const newDigest = "08726b5ef69e1e9072828baa4656713cb3aac93bb096938681278c5600312b2c";
const installedDigest = existsSync(entry)
  ? createHash("sha256").update(readFileSync(entry)).digest("hex")
  : "";
const installed = installedDigest === oldDigest || installedDigest === newDigest;

describe("deferred capability identity", () => {
  it("reports bundle diagnostics without starting a backend", () => {
    expect(catalogProbeDiagnostic()).toMatch(
      /^catalog probe: (desktop bundle unavailable|version=.* sha256=[a-f0-9]{64} pin=(match|mismatch))$/,
    );
  });
  it("only trusts audited version and digest pairs", () => {
    expect(auditedBundleMatches("3.18.0", oldDigest)).toBe(true);
    expect(auditedBundleMatches("3.18.2", newDigest)).toBe(true);
    expect(auditedBundleMatches("3.18.2", oldDigest)).toBe(false);
    expect(auditedBundleMatches("3.18.0", newDigest)).toBe(false);
    expect(auditedBundleMatches("3.18.3", newDigest)).toBe(false);
    expect(auditedBundleMatches("__proto__", newDigest)).toBe(false);
  });
  it.runIf(installed)(
    "accepts only the exact audited 3.18 bundle selected by the launch argv",
    () => {
      expect(
        deferredProbeCapabilityVerified([process.execPath, entry, "app-server", "--stdio"]),
      ).toBe(true);
    },
  );
  it("rejects wrappers, unknown executables, and misleading command arguments", () => {
    for (const argv of [
      ["zcode", "app-server", "--stdio"],
      ["/usr/local/bin/node", "/tmp/zcode.cjs", "app-server", "--stdio"],
      [
        "/usr/bin/env",
        "node",
        "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
        "app-server",
        "--stdio",
      ],
      [process.execPath, entry, "app-server", "--stdio", "--require", "/tmp/hook.js"],
      [
        "/usr/local/bin/node",
        "--require",
        "/tmp/hook.js",
        "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
        "app-server",
        "--stdio",
      ],
      [],
    ])
      expect(deferredProbeCapabilityVerified(argv)).toBe(false);
  });
  it.runIf(installed)(
    "executes only the bytes checked in the child and preserves entry identity",
    () => {
      const dir = mkdtempSync(path.join(process.env.HOME!, "bound-loader-"));
      const fixture = path.join(dir, "entry.cjs");
      const source =
        "process.stdout.write(JSON.stringify([__filename, require.main === module, process.argv.slice(1)]))";
      writeFileSync(fixture, source);
      const hash = createHash("sha256").update(source).digest("hex");
      const command = boundDeferredProbeCommand([
        process.execPath,
        entry,
        "app-server",
        "--stdio",
      ])!;
      const script = command[2]!
        .replace(JSON.stringify(entry), JSON.stringify(fixture))
        .replace(installedDigest, hash);
      const run = () =>
        spawnSync(process.execPath, ["-e", script, fixture, "app-server", "--stdio"], {
          encoding: "utf8",
          env: { PATH: process.env.PATH },
        });
      const valid = run();
      expect(valid.status).toBe(0);
      expect(JSON.parse(valid.stdout)).toEqual([fixture, true, [fixture, "app-server", "--stdio"]]);
      writeFileSync(fixture, 'process.stdout.write("unexpected execution")');
      const tampered = run();
      expect(tampered.status).toBe(78);
      expect(tampered.stdout).toBe("");
    },
  );
});
