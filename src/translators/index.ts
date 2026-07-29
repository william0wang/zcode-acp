/** Translators barrel: internal event types + EventTranslator + ProjectionDiffer + helpers. */

export { EventTranslator } from "./event-translator.js";
export { ProjectionDiffer } from "./projection-differ.js";
export {
  TOOL_KIND_MAP,
  summarizeToolInput,
  renderToolOutput,
  extractExitCode,
  buildResultContent,
  buildDiffContent,
  extractLocations,
  formatTurnError,
  isTransientTurnError,
} from "./tool-helpers.js";
export type {
  InternalEvent,
  ToolCallNewEvent,
  ToolCallUpdateEvent,
  UsageDeltaEvent,
  TextDeltaEvent,
  ReasoningDeltaEvent,
  PlanUpdateEvent,
  FilesChangedEvent,
} from "./types.js";
