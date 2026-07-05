/**
 * Shared utilities: logging and project-wide constants.
 *
 * Logging goes to stderr so it never corrupts the stdout ACP protocol stream.
 */

import path from "node:path";
import process from "node:process";

/** ACP protocol version this server speaks. */
export const PROTOCOL_VERSION = 1;

/** Agent identity advertised in the initialize response. */
export const AGENT_INFO = {
  name: "zcode-acp-server",
  title: "ZCode",
  version: "0.1.0",
} as const;

/** Path to the ZCode v2 config (credentials + provider/model metadata). */
export const ZCODE_CREDS_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".zcode",
  "v2",
  "config.json",
);

/**
 * Slash commands surfaced to the editor. Each maps to a ZCode session method
 * that the server forwards when the user types the command.
 */
export const SLASH_COMMANDS = [
  { name: "compact", description: "Compress conversation context (free up tokens)" },
  {
    name: "goal",
    description: "Set or show the session goal",
    input: { hint: "goal description" },
  },
  { name: "fork", description: "Fork the session at the latest checkpoint" },
  { name: "rewind", description: "Rewind workspace files to the latest checkpoint" },
  {
    name: "steer",
    description: "Append an instruction to a running turn",
    input: { hint: "content" },
  },
  {
    name: "mode",
    description: "Switch permission mode (plan/build/edit/yolo)",
    input: { hint: "plan|build|edit|yolo" },
  },
  {
    name: "model",
    description: "Switch the session model",
    input: { hint: "GLM-5.2|GLM-5-Turbo" },
  },
  {
    name: "thought",
    description: "Set the reasoning effort",
    input: { hint: "max|high|nothink" },
  },
] as const;

/** Static metadata for the configOptions selects (model/mode/thought). */
export const CONFIG_META = {
  model: {
    name: "Model",
    category: "model",
    options: [] as Array<{ value: string; name: string }>,
  },
  mode: {
    name: "Mode",
    category: "mode",
    options: [
      { value: "plan", name: "plan" },
      { value: "build", name: "build" },
      { value: "edit", name: "edit" },
      { value: "yolo", name: "yolo" },
    ],
  },
  thought: {
    name: "Thought Level",
    category: "thought_level",
    options: [
      { value: "max", name: "max" },
      { value: "high", name: "high" },
      { value: "nothink", name: "nothink" },
    ],
  },
} as const;

/** configId → zcode method + param key (model deliberately absent — switch via runtimeModel). */
export const CONFIG_DISPATCH: Record<string, { method: string; paramKey: string }> = {
  mode: { method: "session/setMode", paramKey: "mode" },
  thought: { method: "session/setThoughtLevel", paramKey: "thoughtLevel" },
};

/**
 * Log a message to stderr with a stable prefix. Never use console.log —
 * stdout is reserved for the ACP JSON-RPC stream.
 */
export function log(msg: string): void {
  process.stderr.write(`[zcode-acp] ${msg}\n`);
}
