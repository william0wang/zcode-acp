#!/bin/sh
# macOS-only, fail closed: the real-backend fixture must never inherit the
# user's environment, access their files/keychain, or reach the network.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
real_home=$HOME
root_parent=$(dirname "$root")
node=$(node -p 'process.execPath')
scratch=$(mktemp -d /private/tmp/zcode-catalog-test.XXXXXXXX)
mkdir -p "$scratch/home" "$scratch/config" "$scratch/cache" "$scratch/data" "$scratch/state" "$scratch/runtime" "$scratch/tmp" "$scratch/work"
cat > "$scratch/profile.sb" <<EOF
(version 1)
(allow default)
(deny network*)
(allow network* (local unix-socket))
(deny mach-lookup)
(deny file-read* file-write* (subpath "/Users"))
(allow file-read* file-write* (subpath "$root"))
(allow file-read-metadata (literal "/Users") (literal "$real_home") (literal "$root_parent"))
(deny file-read* file-write* (subpath "/Library/Keychains"))
(deny file-read* file-write* (subpath "/System/Library/Keychains"))
(deny file-read* file-write* (subpath "/private/var/db"))
(deny file-write*)
(allow file-write* (subpath "$scratch") (subpath "$root"))
(allow file-write* (literal "/dev/null"))
EOF
cd "$scratch/work"
run() {
  /usr/bin/sandbox-exec -f "$scratch/profile.sb" /usr/bin/env -i \
    PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin HOME="$scratch/home" \
    XDG_CONFIG_HOME="$scratch/config" XDG_CACHE_HOME="$scratch/cache" \
    XDG_DATA_HOME="$scratch/data" XDG_STATE_HOME="$scratch/state" \
    XDG_RUNTIME_DIR="$scratch/runtime" TMPDIR="$scratch/tmp" \
    ZCODE_HOME="$scratch/home/.zcode" ZCODE_DATA_BASE_DIR="$scratch/home" \
    ZCODE_CATALOG_PROTECTED_HOME="$real_home" ZCODE_CATALOG_REAL_TEST="${real_test:-0}" ZCODE_CATALOG_COMPILED_ENTRY="${compiled_entry:-}" "$node" "$@"
}
# Metadata access to the actual ZCode directory must be denied, not merely
# absent. No configuration or credentials are opened by this check.
run -e 'try { require("node:fs").statSync(require("node:path").join(process.env.ZCODE_CATALOG_PROTECTED_HOME, ".zcode/v2/config.json")); process.exit(1); } catch(e) { if (e.code !== "EPERM" && e.code !== "EACCES") process.exit(1); }'
# A refused TCP connection is insufficient evidence; require sandbox EPERM.
run -e 'require("node:net").connect(9,"127.0.0.1").on("error",e=>process.exit(e.code === "EPERM" || e.code === "EACCES" ? 0 : 1))'
real_test=0
if [ "${1:-}" = "--real" ]; then
  real_test=1
  shift
  ln -s "$root/node_modules" "$scratch/node_modules"
  cp "$root/package.json" "$scratch/package.json"
  run "$root/node_modules/typescript/bin/tsc" -p "$root/tsconfig.json" --outDir "$scratch/dist"
  compiled_entry="$scratch/dist/index.js"
fi
echo "Isolated scratch: $scratch (retained)"
run "$root/node_modules/vitest/vitest.mjs" run --root "$root" "$@"
