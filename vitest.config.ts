import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Hermetic HOME for all tests — see tests/setup/hermetic-home.ts. Guards
    // the shared lazy-alias store (and any other $HOME-derived state) from
    // test writes on dev machines.
    setupFiles: ["./tests/setup/hermetic-home.ts"],
  },
});
