/**
 * Machine-level system stats for the hub's GET /api/system-stats endpoint.
 *
 * Everything is BEST-EFFORT and INDEPENDENTLY degradable: each source runs in
 * its own subprocess (or falls back to a Node builtin) and a failure yields a
 * null field, never an error — the hub can run inside a Seatbelt wrap where
 * `ps`/`pmset` are denied, and a phone checking the machine's health must
 * still get every field that IS readable. Rate fields (CPU %, network B/s,
 * hub CPU %) are sampled from the DELTA between consecutive calls: the hub is
 * resident, so it keeps the last counter snapshot in memory; the first call
 * after boot has no baseline and reports null (clients poll, the second call
 * has real values).
 */

import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import os from "node:os";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Subprocess budget per command — these are all sub-second tools. */
const CMD_TIMEOUT_MS = 5_000;
/** Whole-response TTL: multiple clients polling the same instant must not multiply spawns. */
const COLLECT_TTL_MS = 1_000;
/** Minimum delta window before a rate is recomputed (shorter gaps reuse the last value). */
const RATE_MIN_WINDOW_MS = 500;

export interface VolumeStats {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
}

export interface SystemStats {
  collectedAt: number;
  host: {
    hostname: string;
    /** e.g. "15.8 (24H23)" — null when `sw_vers` is unavailable. */
    osVersion: string | null;
    /** Hardware model id, e.g. "Mac14,9". */
    model: string | null;
    /** Chip description from the CPU table, e.g. "Apple M2 Pro". */
    chip: string | null;
  };
  uptimeS: number;
  cpu: {
    cores: number;
    /** Delta of os.cpus() idle/total across calls; null before a baseline exists. */
    usagePct: number | null;
    loadAvg: [number, number, number];
  };
  memory: {
    totalBytes: number;
    /** free+speculative+inactive+purgeable pages (≈ Activity Monitor's "available"); os.freemem() fallback. */
    availableBytes: number | null;
    usedBytes: number | null;
    swapTotalBytes: number | null;
    swapUsedBytes: number | null;
  };
  storage: {
    root: VolumeStats | null;
    /** Same object as `root` is omitted (null) — one boot volume is the norm on macOS. */
    home: VolumeStats | null;
  };
  battery: {
    present: boolean;
    percent: number | null;
    powerSource: "ac" | "battery" | null;
    /** Raw pmset wording: charging / discharging / charged / finishing charge … */
    status: string | null;
    remainingMin: number | null;
  };
  power: {
    /** True while something holds PreventUserIdleSystemSleep — the machine will not idle-sleep. */
    preventSleep: boolean | null;
    /** Processes holding that assertion (e.g. ["Amphetamine"]). */
    sleepHolders: string[];
    /** Thermal CPU speed limit (100 = full speed; null = no reading recorded). */
    cpuSpeedLimitPct: number | null;
  };
  network: {
    /** Non-internal IPv4 addresses (Node builtin, always available). */
    addresses: string[];
    ssid: string | null;
    /** Summed over all interfaces except lo0, delta across calls. */
    rxBytesPerS: number | null;
    txBytesPerS: number | null;
  };
  processes: {
    hub: { pid: number; rssBytes: number; cpuPct: number | null };
    /** One entry per registered bridge; rss/cpuPct via `ps` (approximate), null when denied. */
    bridges: Array<{
      id: string;
      workspace: string | null;
      pid: number | null;
      rssBytes: number | null;
      cpuPct: number | null;
    }>;
  };
  hub: { version: string; uptimeS: number; instances: number };
}

export interface BridgeProcessInfo {
  id: string;
  pid: number | null;
  workspace: string | null;
}

/** Run a probe command; every failure path collapses to null. */
async function probe(cmd: string, args: string[]): Promise<string | null> {
  try {
    // promisify(execFile) types stdout as string but hands back a Buffer at
    // runtime (default encoding) — normalize so every parser sees a string.
    const { stdout } = await execFileAsync(cmd, args, { timeout: CMD_TIMEOUT_MS });
    return stdout.toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pure parsers (unit-tested against real command output; exported for tests).
// ---------------------------------------------------------------------------

export interface VmStatPageCounts {
  pageSizeBytes: number;
  free: number;
  speculative: number;
  inactive: number;
  purgeable: number;
}

export function parseVmStatOutput(out: string): VmStatPageCounts | null {
  const sizeMatch = out.match(/\(page size of (\d+) bytes\)/);
  if (!sizeMatch) return null;
  const pageSizeBytes = Number(sizeMatch[1]);
  const counts = { free: -1, speculative: -1, inactive: -1, purgeable: -1 };
  const re = /^Pages (free|speculative|inactive|purgeable):\s+(\d+)\./gm;
  for (const m of out.matchAll(re)) {
    counts[m[1] as keyof typeof counts] = Number(m[2]);
  }
  if (Object.values(counts).some((n) => n < 0)) return null;
  return { pageSizeBytes, ...counts };
}

export function parseSwapUsage(out: string): { totalBytes: number; usedBytes: number } | null {
  const m = out.match(/total = ([\d.]+)M\s+used = ([\d.]+)M/);
  if (!m) return null;
  return { totalBytes: Number(m[1]) * 1024 * 1024, usedBytes: Number(m[2]) * 1024 * 1024 };
}

export function parsePmsetBattery(out: string): {
  present: boolean;
  percent: number | null;
  powerSource: "ac" | "battery" | null;
  status: string | null;
  remainingMin: number | null;
} {
  const sourceMatch = out.match(/Now drawing from '([^']+)'/);
  const source = sourceMatch?.[1] ?? null;
  const powerSource = source
    ? /battery/i.test(source)
      ? ("battery" as const)
      : /ac/i.test(source)
        ? ("ac" as const)
        : null
    : null;
  const present = /InternalBattery/.test(out);
  const m = out.match(/(\d+)%;\s*([^;]+?);(?:\s*(\d+):(\d+)\s+remaining|\s*\(no estimate\))?/);
  const h = m?.[3] ? Number(m[3]) : 0;
  const min = m?.[4] ? Number(m[4]) : 0;
  return {
    present,
    percent: m ? Number(m[1]) : null,
    powerSource,
    status: m ? (m[2] ?? "").trim().toLowerCase() : null,
    remainingMin: m?.[3] ? h * 60 + min : null,
  };
}

export function parsePmsetTherm(out: string): number | null {
  const m = out.match(/^\s*CPU_Speed_Limit\s*=\s*(\d+)/m);
  return m ? Number(m[1]) : null;
}

export function parseSleepAssertions(out: string): { active: boolean | null; holders: string[] } {
  // Both the status table and the owning-process lines are indented in real output.
  const statusMatch = out.match(/^\s*PreventUserIdleSystemSleep\s+(\d+)/m);
  const holders = new Set<string>();
  for (const m of out.matchAll(/^\s*pid \d+\(([^)]+)\):.*PreventUserIdleSystemSleep/gm)) {
    holders.add(m[1]);
  }
  return {
    active: statusMatch ? Number(statusMatch[1]) > 0 : null,
    holders: Array.from(holders),
  };
}

export function parseNetstatIfaceBytes(out: string): { rx: number; tx: number } | null {
  let sawData = false;
  let rx = 0;
  let tx = 0;
  const seen = new Set<string>();
  for (const line of out.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    const name = fields[0];
    if (!name || seen.has(name)) continue; // one row per iface (address-family rows repeat totals)
    seen.add(name);
    if (name === "lo0") continue;
    const ifaceRx = Number(fields[6]);
    const ifaceTx = Number(fields[9]);
    if (Number.isFinite(ifaceRx) && Number.isFinite(ifaceTx)) {
      sawData = true;
      rx += ifaceRx;
      tx += ifaceTx;
    }
  }
  return sawData ? { rx, tx } : null;
}

/** Wi-Fi device name (e.g. "en0") from `networksetup -listallhardwareports`. */
export function parseWifiDevice(out: string): string | null {
  const lines = out.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^Hardware Port: Wi-Fi\b/.test(lines[i].trim())) {
      const dev = lines[i + 1].match(/^Device: (\S+)/);
      if (dev) return dev[1];
    }
  }
  return null;
}

export function parseAirportNetwork(out: string): string | null {
  const m = out.match(/^Current Wi-Fi Network: (.+)$/m);
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Collectors.
// ---------------------------------------------------------------------------

/** Host facts never change while the hub lives — probe them once. */
let hostCache: SystemStats["host"] | null = null;

async function collectHost(): Promise<SystemStats["host"]> {
  if (hostCache) return hostCache;
  const [swVers, model] = await Promise.all([
    probe("sw_vers", []),
    probe("sysctl", ["-n", "hw.model"]),
  ]);
  const versionMatch = swVers?.match(/^ProductVersion:\s*(.+)$/m);
  const buildMatch = swVers?.match(/^BuildVersion:\s*(.+)$/m);
  hostCache = {
    hostname: os.hostname(),
    osVersion: versionMatch
      ? versionMatch[1].trim() + (buildMatch ? ` (${buildMatch[1].trim()})` : "")
      : null,
    model: model ? model.trim() : null,
    chip: os.cpus()[0]?.model ?? null,
  };
  return hostCache;
}

async function collectVolume(p: string): Promise<VolumeStats | null> {
  try {
    const s = await statfs(p);
    return {
      totalBytes: s.bsize * s.blocks,
      usedBytes: s.bsize * (s.blocks - s.bfree),
      availableBytes: s.bsize * s.bavail,
    };
  } catch {
    return null;
  }
}

interface CpuBaseline {
  at: number;
  idle: number;
  total: number;
}

interface HubCpuBaseline {
  at: number;
  user: number;
  system: number;
}

interface NetBaseline {
  at: number;
  rx: number;
  tx: number;
}

// Delta baselines persist across calls; last-rate values cover sub-window gaps.
let cpuBaseline: CpuBaseline | null = null;
let hubCpuBaseline: HubCpuBaseline | null = null;
let netBaseline: NetBaseline | null = null;
let lastCpuPct: number | null = null;
let lastHubCpuPct: number | null = null;
let lastRxPerS: number | null = null;
let lastTxPerS: number | null = null;
let collectCache: { at: number; stats: SystemStats } | null = null;

export function resetSystemStatsStateForTest(): void {
  hostCache = null;
  cpuBaseline = null;
  hubCpuBaseline = null;
  netBaseline = null;
  lastCpuPct = null;
  lastHubCpuPct = null;
  lastRxPerS = null;
  lastTxPerS = null;
  collectCache = null;
}

function sampleCpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

async function collectBridges(
  bridges: BridgeProcessInfo[],
): Promise<SystemStats["processes"]["bridges"]> {
  const pids = bridges.filter((b) => typeof b.pid === "number").map((b) => b.pid as number);
  const byPid = new Map<string, { rssBytes: number; cpuPct: number }>();
  if (pids.length > 0) {
    const out = await probe("ps", ["-o", "pid=,%cpu=,rss=", "-p", pids.join(",")]);
    for (const line of out?.split("\n") ?? []) {
      const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)$/);
      if (m) byPid.set(m[1], { cpuPct: Number(m[2]), rssBytes: Number(m[3]) * 1024 });
    }
  }
  return bridges.map((b) => {
    const ps = b.pid !== null ? byPid.get(String(b.pid)) : undefined;
    return {
      id: b.id,
      workspace: b.workspace,
      pid: b.pid,
      rssBytes: ps?.rssBytes ?? null,
      cpuPct: ps?.cpuPct ?? null,
    };
  });
}

export interface HubMeta {
  version: string;
  instances: number;
}

export async function collectSystemStats(
  bridges: BridgeProcessInfo[],
  hubMeta: HubMeta,
): Promise<SystemStats> {
  const now = Date.now();
  if (collectCache && now - collectCache.at < COLLECT_TTL_MS) return collectCache.stats;

  // CPU %: delta of aggregate cpu times against the previous call's snapshot.
  const cpuTimes = sampleCpuTimes();
  if (
    cpuBaseline &&
    now - cpuBaseline.at >= RATE_MIN_WINDOW_MS &&
    cpuTimes.total > cpuBaseline.total
  ) {
    const idle = cpuTimes.idle - cpuBaseline.idle;
    const total = cpuTimes.total - cpuBaseline.total;
    lastCpuPct = total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : lastCpuPct;
  }
  cpuBaseline = { at: now, ...cpuTimes };

  // Hub process CPU %: process.cpuUsage delta over wall clock × cores.
  const hubUsage = process.cpuUsage();
  if (hubCpuBaseline && now - hubCpuBaseline.at >= RATE_MIN_WINDOW_MS) {
    const user = hubUsage.user - hubCpuBaseline.user;
    const system = hubUsage.system - hubCpuBaseline.system;
    const elapsedUs = (now - hubCpuBaseline.at) * 1000 * os.cpus().length;
    lastHubCpuPct = elapsedUs > 0 ? Math.round(((user + system) / elapsedUs) * 1000) / 10 : null;
  }
  hubCpuBaseline = { at: now, ...hubUsage };

  const [
    host,
    vmStat,
    swapOut,
    battOut,
    thermOut,
    assertOut,
    netstatOut,
    hwPortsOut,
    rootVol,
    homeVol,
    bridgesPs,
  ] = await Promise.all([
    collectHost(),
    probe("vm_stat", []),
    probe("sysctl", ["vm.swapusage"]),
    probe("pmset", ["-g", "batt"]),
    probe("pmset", ["-g", "therm"]),
    probe("pmset", ["-g", "assertions"]),
    probe("netstat", ["-ib"]),
    probe("networksetup", ["-listallhardwareports"]),
    collectVolume("/"),
    collectVolume(os.homedir()),
    collectBridges(bridges),
  ]);

  const pages = parseVmStatOutput(vmStat ?? "");
  const availableBytes = pages
    ? (pages.free + pages.speculative + pages.inactive + pages.purgeable) * pages.pageSizeBytes
    : os.freemem();
  const swap = swapOut ? parseSwapUsage(swapOut) : null;
  const battery = parsePmsetBattery(battOut ?? "");
  const sleep = parseSleepAssertions(assertOut ?? "");

  // Wi-Fi SSID needs the device name first; both steps fail to null quietly.
  let ssid: string | null = null;
  const wifiDevice = hwPortsOut ? parseWifiDevice(hwPortsOut) : null;
  if (wifiDevice) {
    ssid = parseAirportNetwork(
      (await probe("networksetup", ["-getairportnetwork", wifiDevice])) ?? "",
    );
  }

  // Network rate: summed iface counters (minus lo0) deltaed against the last call.
  const netTotals = netstatOut ? parseNetstatIfaceBytes(netstatOut) : null;
  if (
    netTotals &&
    netBaseline &&
    now - netBaseline.at >= RATE_MIN_WINDOW_MS &&
    netTotals.rx >= netBaseline.rx &&
    netTotals.tx >= netBaseline.tx
  ) {
    const s = (now - netBaseline.at) / 1000;
    lastRxPerS = Math.round((netTotals.rx - netBaseline.rx) / s);
    lastTxPerS = Math.round((netTotals.tx - netBaseline.tx) / s);
  }
  if (netTotals) netBaseline = { at: now, ...netTotals };

  const sameVolume =
    rootVol !== null &&
    homeVol !== null &&
    rootVol.totalBytes === homeVol.totalBytes &&
    rootVol.availableBytes === homeVol.availableBytes;

  const stats: SystemStats = {
    collectedAt: now,
    host,
    uptimeS: os.uptime(),
    cpu: {
      cores: os.cpus().length,
      usagePct: lastCpuPct,
      loadAvg: os.loadavg() as [number, number, number],
    },
    memory: {
      totalBytes: os.totalmem(),
      availableBytes,
      usedBytes: os.totalmem() - availableBytes,
      swapTotalBytes: swap?.totalBytes ?? null,
      swapUsedBytes: swap?.usedBytes ?? null,
    },
    storage: { root: rootVol, home: sameVolume ? null : homeVol },
    battery,
    power: {
      preventSleep: sleep.active,
      sleepHolders: sleep.holders,
      cpuSpeedLimitPct: thermOut ? parsePmsetTherm(thermOut) : null,
    },
    network: {
      addresses: Object.values(os.networkInterfaces())
        .flat()
        .filter((n) => n && !n.internal && n.family === "IPv4")
        .map((n) => (n as { address: string }).address),
      ssid,
      rxBytesPerS: lastRxPerS,
      txBytesPerS: lastTxPerS,
    },
    processes: {
      hub: { pid: process.pid, rssBytes: process.memoryUsage().rss, cpuPct: lastHubCpuPct },
      bridges: bridgesPs,
    },
    hub: {
      version: hubMeta.version,
      uptimeS: Math.round(process.uptime()),
      instances: hubMeta.instances,
    },
  };
  collectCache = { at: now, stats };
  return stats;
}
