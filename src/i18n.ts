/**
 * Bridge-emitted user-facing strings (editor popups, status/hint lines).
 *
 * Language selection, first match wins:
 *   1. ZCODE_ACP_LANG  — explicit override ("zh", "en"; prefixes like "zh_CN"
 *      accepted, case-insensitive)
 *   2. The ZCode desktop app's language choice — `localePreference` (explicit
 *      user pick), falling back to `locale` (effective), in
 *      ~/.zcode/v2/setting.json; absent when the app was never installed
 *   3. LC_ALL / LC_MESSAGES / LANG — POSIX locale sniff ("zh*" → zh)
 *   4. English (the project ships bilingual READMEs; international default)
 *
 * `log()`/`warn()` diagnostics stay English — they are developer-facing.
 * Resolved per call (not at import) so tests can stub the env per case; the
 * app-settings read is memoized per process (it would otherwise hit the disk
 * on every emitted message).
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type Lang = "en" | "zh";

export function resolveLanguage(env: NodeJS.ProcessEnv = process.env): Lang {
  // Non-string values (a malformed setting.json carrying `locale: 5` must
  // never crash the bridge — pick is reached from messages() on hot paths)
  // read as "no preference".
  const pick = (value: unknown): Lang | undefined => {
    if (typeof value !== "string") return undefined;
    const v = value.toLowerCase();
    if (v.startsWith("zh")) return "zh";
    if (v.startsWith("en")) return "en";
    return undefined;
  };
  return (
    pick(env.ZCODE_ACP_LANG) ??
    pick(appLocale()) ??
    pick(env.LC_ALL) ??
    pick(env.LC_MESSAGES) ??
    pick(env.LANG) ??
    "en"
  );
}

/** The ZCode desktop app's language choice, if the settings file exists.
 *  Memoized with an explicit flag: a settings value of literal null must
 *  cache as "no app locale", not re-read the file on every call. */
let appLocaleCache: string | undefined;
let appLocaleRead = false;

function appLocale(): string | undefined {
  if (!appLocaleRead) {
    appLocaleRead = true;
    let locale: string | undefined;
    try {
      const raw = readFileSync(path.join(os.homedir(), ".zcode", "v2", "setting.json"), "utf8");
      // Editors saving UTF-8 with a BOM leave \uFEFF in the string; JSON.parse
      // rejects it, which would silently fall the bridge back to English.
      const bomless = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      const parsed = JSON.parse(bomless) as { localePreference?: unknown; locale?: unknown };
      const pref =
        typeof parsed.localePreference === "string" ? parsed.localePreference : undefined;
      const eff = typeof parsed.locale === "string" ? parsed.locale : undefined;
      locale = pref || eff; // an empty preference string reads as unset
    } catch {
      locale = undefined; // app never installed / unreadable / malformed
    }
    appLocaleCache = locale;
  }
  return appLocaleCache;
}

export interface Messages {
  /** Sandbox permission popup — the four ACP option names. */
  sandboxOptionAllowAlways: string;
  sandboxOptionAllowOnce: string;
  sandboxOptionRejectOnce: string;
  sandboxOptionRejectAlways: string;
  sandboxPopupTitle: (path: string) => string;
  sandboxPopupDetails: (path: string) => string;
  /** Island/strictGit denies can never be overridden by an allow. */
  sandboxProtectedHint: string;
  /** A grant for $HOME (or an ancestor) would gut the sandbox. */
  sandboxOverBroadHint: (path: string) => string;
  /** Path already in the config's deny list (earlier "always reject"). */
  sandboxDenyListedHint: (path: string) => string;
  sandboxRejectAlwaysPersisted: (path: string) => string;
  sandboxRejectAlwaysUnpersisted: (path: string) => string;
  sandboxRejectOnceHint: (path: string) => string;
  /** Continuation prompt sent to the model after an allow restart. */
  sandboxContinuationPrompt: (path: string) => string;
  sandboxRestartHint: (path: string) => string;
  sandboxResumedStatus: string;
  /** EPERM seen in tool output but no path could be extracted. */
  sandboxGenericDenialHint: string;
  networkRetry: (attempt: number, total: number) => string;
  requestFailed: (err: string) => string;
  /** Prompt queued behind a still-generating turn (drain gate). */
  promptQueuedBehindTurn: string;
  thinkingPlaceholder: string;
  /** Steered prompt silently swallowed by the still-running turn. */
  messageSwallowedByTurn: string;
  interactionInterrupted: string;
  /** ExitPlanMode permission popup. */
  planApproveOption: string;
  planRejectOption: string;
  planPopupTitle: string;
  /** AskUserQuestion: skip choices in both popup and elicitation forms. */
  askSkipOption: string;
  askSkipQuestionTitle: string;
  askIncludeOption: (label: string) => string;
  askSkipLabelOption: (label: string) => string;
  /** tool_call title for an AskUserQuestion turn in the transcript. */
  askQuestionsTitle: string;
  /** Slash-command feedback lines rendered into the chat. */
  slashCompacted: string;
  slashCompactTimeout: string;
  slashGoalSet: (value: string) => string;
  slashForked: (sessionId: string) => string;
  slashModelSet: (value: string) => string;
  slashTuiOnly: (cmd: string) => string;
  /** Collapsed tool-call titles during session/load replay. */
  replayCompactSummary: string;
  replayContextHandoff: string;
  replayToolFallback: (tool: string) => string;
  /** Changed-files card emitted as a tool_call update during a live turn. */
  changedFilesTitle: (count: number, preview: string) => string;
  affectedFilesList: (files: string[]) => string;
  /** `/mcp` server-listing card. */
  mcpNone: string;
  mcpHeader: (count: number) => string;
  mcpFromConfig: string;
  mcpFromPlugins: string;
  mcpFooter: string;
  /** Editor slash-command menu: localized descriptions for the static
   *  commands (names and argument hints stay as-is — they are tokens). */
  slashCommandDescriptions: Record<string, string>;
  /** Auto-compaction status lines. */
  autoCompactStart: (used: string, threshold: string) => string;
  autoCompactTimeout: string;
  autoCompactDone: string;
  autoCompactFailed: (err: string) => string;
  /** Pre-popup tool_call titles for interactive requests. */
  popupTitleExitPlan: string;
  popupTitleToolPermission: (tool: string) => string;
  popupTitleInteraction: string;
  /** Replay fallback title when a history tool has no name/title. */
  replayToolCallFallback: string;
  /** Background-task card title (empty description → fallback). */
  backgroundTaskTitle: (description: string) => string;
  /** Slash-command errors surfaced to the editor via RequestError. */
  slashErrGoalArg: string;
  slashErrModelArg: string;
  slashErrSwitchFailed: (model: string) => string;
  slashErrArg: (cmd: string) => string;
  slashErrUnknown: (cmd: string) => string;
  slashErrFailed: (cmd: string, msg: string) => string;
}

const zh: Messages = {
  sandboxOptionAllowAlways: "始终允许",
  sandboxOptionAllowOnce: "仅此一次",
  sandboxOptionRejectOnce: "拒绝一次",
  sandboxOptionRejectAlways: "始终拒绝",
  sandboxPopupTitle: (p) => `沙箱写入放行:${p}`,
  sandboxPopupDetails: (p) =>
    `沙箱拒绝了工作区外的写入:${p}\n“始终允许”写入配置的 allow 列表,“始终拒绝”写入 deny 列表(.zcode/acp/sandbox.json,可编辑撤销)。`,
  sandboxProtectedHint:
    "[该路径受沙箱保护(.zcode/acp 配置区或 strictGit 的 .git),不能通过弹窗放行。strictGit 可在 .zcode/acp/sandbox.json 中关闭。]",
  sandboxOverBroadHint: (p) =>
    `[${p} 范围过宽($HOME 或其上级),沙箱不会弹窗放行;确需放行请手动编辑 .zcode/acp/sandbox.json 的 allow 列表。]`,
  sandboxDenyListedHint: (p) =>
    `[${p} 已在 .zcode/acp/sandbox.json 的 deny 列表中(你之前选择过始终拒绝)。要撤销,编辑该文件的 deny 数组即可。]`,
  sandboxRejectAlwaysPersisted: (p) =>
    `[已记入始终拒绝 ${p}(.zcode/acp/sandbox.json 的 deny 列表,可编辑撤销)。]`,
  sandboxRejectAlwaysUnpersisted: (p) =>
    `[已拒绝 ${p}(配置不可写,未持久化,同类写入下次仍会询问。)]`,
  sandboxRejectOnceHint: (p) =>
    `[已拒绝沙箱放行 ${p},未保存任何决定,同类写入会再次询问;如需放行,可编辑 .zcode/acp/sandbox.json 的 allow 列表(由桥写入,Agent 不可改)。]`,
  sandboxContinuationPrompt: (p) => `[沙箱已放行 ${p},请继续刚才的任务。]`,
  sandboxRestartHint: (p) => `[沙箱已放行 ${p},正在重启后端以应用新权限,随后自动继续…]`,
  sandboxResumedStatus: "[沙箱后端已重启,会话已恢复,自动继续刚才的任务…]",
  sandboxGenericDenialHint:
    "[沙箱拒绝了白名单外的写入。可放行目录:在弹窗中选择允许,或编辑 .zcode/acp/sandbox.json 后重启会话。]",
  networkRetry: (attempt, total) => `[网络异常，正在重试 (${attempt}/${total})…]`,
  requestFailed: (err) => `[请求失败：${err}。会话仍可用，请重新发送消息重试。]`,
  promptQueuedBehindTurn: "[上一个回复仍在生成，等待结束后发送…]",
  thinkingPlaceholder: "正在思考…",
  messageSwallowedByTurn: "[消息被并入仍在生成的回合，将被丢弃，请重新发送]",
  interactionInterrupted: "交互中断：连接关闭或超时，请重新发起对话。",
  planApproveOption: "同意——退出计划模式",
  planRejectOption: "拒绝——继续规划",
  planPopupTitle: "退出计划模式",
  askSkipOption: "跳过",
  askSkipQuestionTitle: "跳过此问题",
  askIncludeOption: (lb) => `包含：${lb}`,
  askSkipLabelOption: (lb) => `跳过：${lb}`,
  askQuestionsTitle: "问题",
  slashCompacted: "✓ 已压缩对话上下文",
  slashCompactTimeout: "⚠ 压缩超时（300s），后端可能仍在处理——稍等片刻再发送",
  slashGoalSet: (v) => `✓ 目标已设置：${v}`,
  slashForked: (id) => `✓ 已分叉新会话：${id}`,
  slashModelSet: (v) => `✓ 模型 = ${v}`,
  slashTuiOnly: (cmd) => `⚠ /${cmd} 在 ACP 模式下不可用（需要 ZCode TUI）`,
  replayCompactSummary: "压缩摘要",
  replayContextHandoff: "上下文交接",
  replayToolFallback: (tool) => `${tool} 工具`,
  changedFilesTitle: (count, preview) => `变更文件 (${count}): ${preview}`,
  affectedFilesList: (files) => `受影响文件:\n${files.join("\n")}`,
  mcpNone: "📡 尚未配置 MCP 服务器。\n请使用 ZCode 桌面应用添加 MCP 服务器。",
  mcpHeader: (n) => `📡 MCP 服务器 (${n})`,
  mcpFromConfig: "来自 config.json:",
  mcpFromPlugins: "来自插件:",
  mcpFooter: "MCP 工具会在需要时由模型自动调用。",
  slashCommandDescriptions: {
    compact: "压缩对话上下文（释放 token）",
    goal: "设置或查看会话目标",
    fork: "在最新检查点分叉会话",
    mode: "切换权限模式（plan/build/edit/yolo）",
    model: "切换会话模型",
    thought: "设置思考深度",
    quota: "查看剩余用量配额（5 小时 / 周 / MCP）",
    mcp: "列出可用的 MCP 服务器",
    init: "创建或更新工作区 AGENTS.md 指令",
  },
  autoCompactStart: (used, threshold) =>
    `🔄 自动压缩: 上下文用量 ${used} ≥ 阈值 ${threshold},正在压缩…`,
  autoCompactTimeout: "⚠ 自动压缩超时（300s）——后端可能仍在处理",
  autoCompactDone: "✓ 自动压缩: 上下文已压缩",
  autoCompactFailed: (err) => `⚠ 自动压缩失败: ${err}`,
  popupTitleExitPlan: "可以开始编码了吗？",
  popupTitleToolPermission: (tool) => `工具权限 (${tool})`,
  popupTitleInteraction: "交互",
  replayToolCallFallback: "工具调用",
  backgroundTaskTitle: (d) => (d ? `[后台] ${d}` : "[后台] 任务"),
  slashErrGoalArg: "/goal 需要目标描述",
  slashErrModelArg: "/model 需要模型 id",
  slashErrSwitchFailed: (model) => `模型切换失败: ${model}`,
  slashErrArg: (cmd) => `/${cmd} 需要参数`,
  slashErrUnknown: (cmd) => `未知命令 /${cmd}`,
  slashErrFailed: (cmd, msg) => `${cmd} 失败: ${msg}`,
};

const en: Messages = {
  sandboxOptionAllowAlways: "Always allow",
  sandboxOptionAllowOnce: "Allow once",
  sandboxOptionRejectOnce: "Reject once",
  sandboxOptionRejectAlways: "Always reject",
  sandboxPopupTitle: (p) => `Sandbox write request: ${p}`,
  sandboxPopupDetails: (p) =>
    `The sandbox denied a write outside the workspace: ${p}\n"Always allow" persists to the config's allow list, "Always reject" to its deny list (.zcode/acp/sandbox.json, editable to undo).`,
  sandboxProtectedHint:
    "[This path is sandbox-protected (the .zcode/acp config area, or .git under strictGit) and cannot be granted via popup. strictGit can be disabled in .zcode/acp/sandbox.json.]",
  sandboxOverBroadHint: (p) =>
    `[${p} is too broad ($HOME or an ancestor) for a popup grant; to allow it, edit the allow list in .zcode/acp/sandbox.json by hand.]`,
  sandboxDenyListedHint: (p) =>
    `[${p} is in the deny list of .zcode/acp/sandbox.json (you chose "Always reject" earlier). Edit that file's deny array to undo.]`,
  sandboxRejectAlwaysPersisted: (p) =>
    `[Recorded as always-rejected: ${p} (deny list in .zcode/acp/sandbox.json, editable to undo).]`,
  sandboxRejectAlwaysUnpersisted: (p) =>
    `[Rejected ${p} (config not writable, nothing persisted; the same write will ask again.)]`,
  sandboxRejectOnceHint: (p) =>
    `[Sandbox grant rejected for ${p}; no decision was saved and the same write will ask again. To grant, edit the allow list in .zcode/acp/sandbox.json (bridge-written, not agent-writable).]`,
  sandboxContinuationPrompt: (p) => `[Sandbox granted ${p}; please continue the previous task.]`,
  sandboxRestartHint: (p) =>
    `[Sandbox granted ${p}; restarting the backend to apply the new permission, then continuing automatically…]`,
  sandboxResumedStatus: "[Sandbox backend restarted, session restored; continuing the task…]",
  sandboxGenericDenialHint:
    "[The sandbox denied a write outside the whitelist. To grant a directory: choose Allow in the popup, or edit .zcode/acp/sandbox.json and restart the session.]",
  networkRetry: (attempt, total) => `[Network error, retrying (${attempt}/${total})…]`,
  requestFailed: (err) => `[Request failed: ${err}. The session is still usable — please resend.]`,
  promptQueuedBehindTurn: "[The previous reply is still generating; sending once it finishes…]",
  thinkingPlaceholder: "Thinking…",
  messageSwallowedByTurn:
    "[The message was merged into a still-generating turn and will be dropped; please resend it.]",
  interactionInterrupted:
    "Interaction interrupted: the connection closed or timed out; please start the request again.",
  planApproveOption: "Approve — exit plan mode",
  planRejectOption: "Reject — keep planning",
  planPopupTitle: "Exit plan mode",
  askSkipOption: "Skip",
  askSkipQuestionTitle: "Skip this question",
  askIncludeOption: (lb) => `Include: ${lb}`,
  askSkipLabelOption: (lb) => `Skip: ${lb}`,
  askQuestionsTitle: "questions",
  slashCompacted: "✓ compacted conversation context",
  slashCompactTimeout:
    "⚠ compact timed out (300s), backend may still be processing — wait a bit before sending",
  slashGoalSet: (v) => `✓ goal set: ${v}`,
  slashForked: (id) => `✓ forked new session: ${id}`,
  slashModelSet: (v) => `✓ model = ${v}`,
  slashTuiOnly: (cmd) => `⚠ /${cmd} is not available in ACP mode (requires ZCode TUI)`,
  replayCompactSummary: "Compact summary",
  replayContextHandoff: "Context handoff",
  replayToolFallback: (tool) => `${tool} tool`,
  changedFilesTitle: (count, preview) => `changed files (${count}): ${preview}`,
  affectedFilesList: (files) => `affected files:\n${files.join("\n")}`,
  mcpNone: "📡 No MCP servers configured.\nUse the ZCode desktop app to add MCP servers.",
  mcpHeader: (n) => `📡 MCP Servers (${n})`,
  mcpFromConfig: "From config.json:",
  mcpFromPlugins: "From plugins:",
  mcpFooter: "MCP tools are auto-invoked by the model when needed.",
  slashCommandDescriptions: {
    compact: "Compress conversation context (free up tokens)",
    goal: "Set or show the session goal",
    fork: "Fork the session at the latest checkpoint",
    mode: "Switch permission mode (plan/build/edit/yolo)",
    model: "Switch the session model",
    thought: "Set the reasoning effort",
    quota: "Show remaining usage quota (5h / weekly / MCP)",
    mcp: "List available MCP servers",
    init: "Create or update workspace AGENTS.md instructions",
  },
  autoCompactStart: (used, threshold) =>
    `🔄 auto-compact: context usage ${used} ≥ threshold ${threshold}, compressing…`,
  autoCompactTimeout: "⚠ auto-compact timed out (300s) — backend may still be processing",
  autoCompactDone: "✓ auto-compact: context compressed",
  autoCompactFailed: (err) => `⚠ auto-compact failed: ${err}`,
  popupTitleExitPlan: "Ready to code?",
  popupTitleToolPermission: (tool) => `tool permission (${tool})`,
  popupTitleInteraction: "interaction",
  replayToolCallFallback: "tool call",
  backgroundTaskTitle: (d) => (d ? `[background] ${d}` : "[background] task"),
  slashErrGoalArg: "/goal requires a goal description",
  slashErrModelArg: "/model requires a model id",
  slashErrSwitchFailed: (model) => `model switch failed for ${model}`,
  slashErrArg: (cmd) => `/${cmd} requires an argument`,
  slashErrUnknown: (cmd) => `unknown /${cmd}`,
  slashErrFailed: (cmd, msg) => `${cmd} failed: ${msg}`,
};

/** Current message table — resolved per call so env changes/tests apply live. */
export function messages(): Messages {
  return resolveLanguage() === "zh" ? zh : en;
}
