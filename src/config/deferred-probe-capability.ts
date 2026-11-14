import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

// Only these macOS desktop bundle version/hash pairs are audited; the CLI version
// is unrelated. Unknown versions, other platforms, paths and builds fail closed.
// The entry bytes are pinned, not the Node interpreter or dynamically loaded resources.
const ENTRY = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const AUDITED: Readonly<Record<string, string>> = {
  "3.18.0": "26785f28ab8fb9f8b0f3821f2bf71d294f4d0b8bf28108785292f86c7e14090d",
  "3.18.2": "08726b5ef69e1e9072828baa4656713cb3aac93bb096938681278c5600312b2c",
};

export function auditedBundleMatches(version: string, digest: string): boolean {
  return Object.hasOwn(AUDITED, version) && AUDITED[version] === digest;
}

/** Identity is necessary, but is not an authorization to access a data store. */
function verifiedDigest(argv?: readonly string[]): string | null {
  if (!argv || argv.length < 4) return null;
  try {
    // Do not trust wrappers, interpreter flags or aliases to an arbitrary CLI.
    if (realpathSync(argv[0]!) !== realpathSync(process.execPath)) return null;
    let index = 1;
    if (argv[index] === "--no-network-family-autoselection") index++;
    if (argv[index] === "--dns-result-order=ipv4first") index++;
    if (argv[index] !== ENTRY || argv[index + 1] !== "app-server" || argv[index + 2] !== "--stdio")
      return null;
    const tail = argv.slice(index + 3);
    if (tail.length !== 0 && !(tail.length === 2 && tail[0] === "--disallowed-tools" && tail[1]))
      return null;
    if (realpathSync(ENTRY) !== ENTRY) return null;
    const plist = readFileSync(path.join(path.dirname(ENTRY), "../../Info.plist"), "utf8");
    const version = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/u.exec(
      plist,
    )?.[1];
    const expected = version ? AUDITED[version] : undefined;
    if (!expected) return null;
    const actual = createHash("sha256").update(readFileSync(ENTRY)).digest("hex");
    return auditedBundleMatches(version!, actual) ? expected : null;
  } catch {
    return null;
  }
}

export function deferredProbeCapabilityVerified(argv?: readonly string[]): boolean {
  return verifiedDigest(argv) !== null;
}

/** Read, verify and execute the same bytes inside the child, retaining the
 * original filename for bundled resource and relative module resolution. */
export function boundDeferredProbeCommand(argv: readonly string[]): string[] | null {
  const digest = verifiedDigest(argv);
  if (!digest) return null;
  const loader = `
    const fs = require("node:fs"), crypto = require("node:crypto"), Module = require("node:module"), path = require("node:path");
    const filename = ${JSON.stringify(ENTRY)};
    const bytes = fs.readFileSync(filename);
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== ${JSON.stringify(digest)}) process.exit(78);
    const main = new Module(filename);
    main.id = "."; main.filename = filename; main.paths = Module._nodeModulePaths(path.dirname(filename));
    process.mainModule = main; Module._cache[filename] = main;
    main._compile(bytes.toString("utf8"), filename);
    main.loaded = true;
  `;
  const index = argv.indexOf(ENTRY);
  return [argv[0]!, ...argv.slice(1, index), "-e", loader, ...argv.slice(index)];
}
