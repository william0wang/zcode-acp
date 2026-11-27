/**
 * Keep the user's MCP servers (`mcp.servers` in cli/config.json) in sessions
 * whose client declares servers of its own.
 *
 * The backend reads the user config's servers ONLY when session/create·resume
 * carries no `mcpServers`: a non-empty list is the session's whole MCP config
 * and silently displaces them (desktop 4.0.0: the list becomes the runtime's
 * mcpConfig outright; observed 2026-11-26 — an empty param connected the
 * user's servers, a one-entry param connected none of them). A client that
 * injects a server of its own (paseo does) therefore dropped every
 * user-configured one from every session.
 *
 * `mergeUserConfigMcpServers` unions them back into a NON-EMPTY client list;
 * a client entry wins a same-name clash. An empty/absent list is left
 * untouched, so the backend keeps doing its own loading there — its
 * conversion, the reference, is never swapped for this one's without need.
 *
 * Entries are emitted in the backend's wire shape (`ZcodeMcpServer`; strict
 * zod, so only known keys) and are schema-valid by construction. Should the
 * backend reject them anyway (schema drift), handlers/session.ts retries with
 * the client's own list and latches the verdict per backend generation — a
 * config entry must never brick a session.
 *
 * Best-effort throughout: a malformed config or entry yields fewer (or no)
 * servers and never throws into the create/resume path.
 *
 * The conversion mirrors the backend's own reading of a config entry
 * (desktop 4.0.0): the same legacy rewrites, the same strict key set, and
 * every field the wire can carry. A session must get the server the backend
 * would have built from the same config, so an entry it would reject or
 * disable is left out rather than sent trimmed.
 */

import type {
  ZcodeMcpHttpServer,
  ZcodeMcpOAuth,
  ZcodeMcpServer,
  ZcodeMcpServerOptions,
  ZcodeMcpStdioServer,
} from "../backend/types.js";
import { log } from "../utils.js";
import { readCliConfig, type McpServerConfig } from "./mcp-discovery.js";

/** Merged list → the client list it was built from. */
const CLIENT_ONLY = new WeakMap<readonly unknown[], readonly unknown[]>();

/** A config value that is present but not in a shape the backend accepts. */
const INVALID = Symbol("invalid");

/** Keys of a config entry the backend's schema knows, per transport. */
const ALLOWED_KEYS = {
  stdio: new Set(["type", "command", "args", "cwd", "env"]),
  http: new Set(["type", "url", "headers", "oauth"]),
};
/** ...and the ones both transports accept. */
const COMMON_KEYS = new Set(["alwaysLoad", "isolation", "protocolVersion", "enabled", "timeoutMs"]);
const ISOLATIONS = ["session", "workspace"] as const;
const PROTOCOL_VERSIONS = ["auto", "legacy", "2026-07-28"] as const;
const OAUTH_KEYS: Record<string, Set<string>> = {
  client_credentials: new Set(["type", "clientId", "clientSecret", "clientName", "scope"]),
  authorization_code: new Set([
    "type",
    "clientId",
    "clientSecret",
    "clientName",
    "redirectPath",
    "scope",
  ]),
};

/** Enabled user-config servers in the backend's wire shape, in config order. */
export function loadUserConfigMcpServers(): ZcodeMcpServer[] {
  const servers: ZcodeMcpServer[] = [];
  // JSON-parsed data: never trust the shape the types claim.
  const entries: unknown = readCliConfig()?.mcp?.servers;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return servers;
  for (const [name, cfg] of Object.entries(entries)) {
    if (!name.trim() || !cfg || typeof cfg !== "object" || Array.isArray(cfg)) continue;
    const server = toWireServer(name, cfg as McpServerConfig);
    if (server) servers.push(server);
  }
  return servers;
}

/**
 * Union the user's config servers into a NON-EMPTY client list. Client entries
 * keep their order and win on a name clash. Returns `clientServers` itself
 * when nothing is added — callers compare by identity.
 */
export function mergeUserConfigMcpServers<T extends { readonly name: string }>(
  clientServers: readonly T[] | undefined,
  rejected: boolean,
): readonly (T | ZcodeMcpServer)[] | undefined {
  // An absent/empty list displaces nothing: the backend loads the user config
  // itself there, which is exactly the behavior to preserve.
  if (rejected || !clientServers || clientServers.length === 0) return clientServers;
  const taken = new Set(clientServers.map((server) => server.name));
  const added = loadUserConfigMcpServers().filter((server) => !taken.has(server.name));
  if (added.length === 0) return clientServers;
  const merged: readonly (T | ZcodeMcpServer)[] = [...clientServers, ...added];
  CLIENT_ONLY.set(merged, clientServers);
  return merged;
}

/**
 * The client list behind a list built by mergeUserConfigMcpServers, or null
 * when it carried no config servers (nothing to fall back from).
 */
export function clientServersOf(servers: unknown): readonly unknown[] | null {
  if (!Array.isArray(servers)) return null;
  return CLIENT_ONLY.get(servers) ?? null;
}

/**
 * One config entry in the wire shape; null unless it is an enabled stdio/http
 * server the backend itself would accept.
 */
function toWireServer(name: string, entry: McpServerConfig): ZcodeMcpServer | null {
  // JSON-parsed data: never trust the shape the types claim.
  const cfg = normalizeEntry(entry as unknown as Record<string, unknown>);
  if (cfg.enabled === false) return null;
  const transport =
    cfg.type === "stdio" ? "stdio" : cfg.type === "http" || cfg.type === "sse" ? "http" : null;
  const options = transport ? serverOptions(cfg, transport) : INVALID;
  if (!transport || options === INVALID) {
    log(`user-mcp-servers: "${name}" left out (not a stdio/http entry the backend accepts)`);
    return null;
  }
  return transport === "stdio" ? stdioServer(name, cfg, options) : httpServer(name, cfg, options);
}

/**
 * The backend's own rewrites for a config entry before it validates one
 * strictly: legacy spellings are folded and keys it ignores are dropped.
 */
function normalizeEntry(raw: Record<string, unknown>): Record<string, unknown> {
  const cfg = { ...raw };
  if (!("env" in cfg) && "environment" in cfg) cfg.env = cfg.environment;
  delete cfg.environment;
  if (typeof cfg.enable === "boolean" || typeof cfg.enabled === "boolean") {
    cfg.enabled = cfg.enable === false ? false : (cfg.enabled ?? true);
  }
  delete cfg.enable;
  delete cfg.timeout;
  delete cfg.startup_timeout_sec;
  if (cfg.type === "remote") cfg.type = "http";
  else if (typeof cfg.type !== "string") {
    if (isNonBlank(cfg.command)) cfg.type = "stdio";
    else if (isNonBlank(cfg.url)) cfg.type = "http";
  }
  if ((cfg.type === "http" || cfg.type === "sse") && cfg.headers === undefined) {
    if (cfg.http_headers !== undefined) cfg.headers = cfg.http_headers;
  }
  delete cfg.http_headers;
  return cfg;
}

/**
 * The optional fields both transports carry, or INVALID when the entry has a
 * key the backend's strict schema rejects, or one of the wrong shape.
 */
function serverOptions(
  cfg: Record<string, unknown>,
  transport: "stdio" | "http",
): ZcodeMcpServerOptions | typeof INVALID {
  for (const key of Object.keys(cfg)) {
    if (!COMMON_KEYS.has(key) && !ALLOWED_KEYS[transport].has(key)) return INVALID;
  }
  const isolation = optionalEnum(cfg.isolation, ISOLATIONS);
  const protocolVersion = optionalEnum(cfg.protocolVersion, PROTOCOL_VERSIONS);
  const { alwaysLoad, enabled } = cfg;
  if (isolation === INVALID || protocolVersion === INVALID) return INVALID;
  if (alwaysLoad !== undefined && typeof alwaysLoad !== "boolean") return INVALID;
  if (enabled !== undefined && typeof enabled !== "boolean") return INVALID;
  return {
    ...(alwaysLoad !== undefined ? { alwaysLoad } : {}),
    ...(isolation !== undefined ? { isolation } : {}),
    ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    // The wire takes whole milliseconds: a fractional timeout falls back to
    // the backend's default instead of costing the server.
    ...(isTimeoutMs(cfg.timeoutMs) ? { timeoutMs: cfg.timeoutMs } : {}),
  };
}

function stdioServer(
  name: string,
  cfg: Record<string, unknown>,
  options: ZcodeMcpServerOptions,
): ZcodeMcpStdioServer | null {
  const { command, args, cwd, env } = cfg;
  if (!isNonBlank(command)) return null;
  if (args !== undefined && !isStringArray(args)) return null;
  if (cwd !== undefined && !isNonBlank(cwd)) return null;
  const envMap = stringRecord(env);
  if (envMap === null) return null;
  return {
    name,
    command,
    args: args ?? [],
    // `env` is REQUIRED on the wire (it may be empty).
    env: asPairArray(envMap),
    ...(cwd !== undefined ? { cwd } : {}),
    ...options,
  };
}

function httpServer(
  name: string,
  cfg: Record<string, unknown>,
  options: ZcodeMcpServerOptions,
): ZcodeMcpHttpServer | null {
  const { url, headers, oauth } = cfg;
  if (!isNonBlank(url)) return null;
  const headerMap = stringRecord(headers);
  const grant = toOauth(oauth);
  if (headerMap === null || grant === INVALID) return null;
  return {
    name,
    type: cfg.type as "http" | "sse",
    url,
    // `headers` is REQUIRED on the wire (it may be empty).
    headers: asPairArray(headerMap),
    ...(grant ? { oauth: grant } : {}),
    ...options,
  };
}

/** A config map of strings (absent counts as empty), or null when malformed. */
function stringRecord(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.values(value).some((item) => typeof item !== "string")) return null;
  return value as Record<string, string>;
}

/** Flatten a string-valued map into the wire's [{name, value}] pair array. */
function asPairArray(map: Record<string, string>): { name: string; value: string }[] {
  return Object.entries(map).map(([name, value]) => ({ name, value }));
}

/**
 * An entry's `oauth` block as the wire carries it (the config's own shape), or
 * INVALID unless it is one of the two grants, fully formed.
 */
function toOauth(value: unknown): ZcodeMcpOAuth | undefined | typeof INVALID {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return INVALID;
  const block = value as Record<string, unknown>;
  const keys = OAUTH_KEYS[block.type as string];
  if (!keys) return INVALID;
  for (const [key, item] of Object.entries(block)) {
    if (!keys.has(key) || !isNonBlank(item)) return INVALID;
  }
  const required = block.type === "client_credentials" ? ["clientId", "clientSecret"] : [];
  if (required.some((key) => block[key] === undefined)) return INVALID;
  return block as unknown as ZcodeMcpOAuth;
}

/** A present value that must be one of `allowed`. */
function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined | typeof INVALID {
  if (value === undefined) return undefined;
  return allowed.includes(value as T) ? (value as T) : INVALID;
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isTimeoutMs(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
