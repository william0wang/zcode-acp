/** Backend layer barrel: ZCode subprocess client + listener + resolve + credentials. */

export { ZcodeBackend, type ServerRequest, type EventListener } from "./client.js";
export { EventStreamListener, TurnMonitor, type NextId } from "./listener.js";
export { resolveZcodeCommand } from "./resolve.js";
export { loadZcodeCredentials, mergeEnvWithCreds, type ZcodeCredentials } from "./credentials.js";
export {
  SANDBOX_ENV,
  appendSandboxAllow,
  armSandboxArgv,
  buildSandboxProfile,
  collectSandboxWorkspaces,
  projectSandboxEnabled,
  readSandboxConfig,
  resetSandboxDecisionForTest,
  sandboxActive,
  sandboxConfigPath,
  type SandboxConfig,
} from "./sandbox.js";
export type {
  ZcodeRequest,
  ZcodeNotification,
  ZcodeResponse,
  ZcodeInbound,
  ZcodeSessionInfo,
  ZcodeCreateResult,
  ZcodeSessionListItem,
  ZcodeListResult,
  ZcodeEvent,
  ZcodeEventType,
  ZcodeSubscribeResult,
  ZcodeSnapshot,
  ZcodeProjection,
  ZcodeMessage,
  ZcodeMessagePart,
  ZcodeMessagesResult,
  ZcodeReadResult,
  ZcodeInteractionPermissionParams,
  ZcodeInteractionUserInputParams,
  ZcodeInteractionResponse,
} from "./types.js";
