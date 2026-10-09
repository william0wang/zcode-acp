import { constants, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, constants: { ...actual.constants, O_NOFOLLOW: undefined } };
});

import {
  bridgeAccountsPath,
  readBridgeAccounts,
  saveBridgeAccount,
} from "../src/config/bridge-accounts.js";

const file = bridgeAccountsPath();
afterEach(() => rmSync(path.dirname(file), { recursive: true, force: true }));

it("refuses dangling links even when O_NOFOLLOW is unavailable", async () => {
  expect(constants.O_NOFOLLOW).toBeUndefined();
  mkdirSync(path.dirname(file), { recursive: true });
  const target = file + ".missing";
  symlinkSync(target, file);
  expect(() => readBridgeAccounts()).toThrow("Cannot read bridge account configuration");
  await expect(saveBridgeAccount("zai", "synthetic-link-test-key")).rejects.toThrow(
    "existing accounts were preserved",
  );
  expect(readlinkSync(file)).toBe(target);
});
