// @vitest-environment node
// GET /api/system-stats collection (src/remote/system-stats.ts).
//
// Parsers are pinned against REAL command output sampled on macOS 15.8
// (2026-10). The collector tests mock execFile/statfs and drive the delta
// logic: rate fields (CPU %, network B/s, hub CPU %) must be null on the
// first call and real once a ≥500ms-apart second call lands with moved
// counters; every subprocess denial must degrade to null fields — the hub
// can run inside a Seatbelt wrap where ps/pmset are denied.
import { beforeEach, describe, expect, test, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
const statfsMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ execFile: execFileMock }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, statfs: statfsMock };
});

import os from "node:os";
import {
  collectSystemStats,
  parseAirportNetwork,
  parseNetstatIfaceBytes,
  parsePmsetBattery,
  parsePmsetTherm,
  parseSleepAssertions,
  parseSwapUsage,
  parseVmStatOutput,
  parseWifiDevice,
  resetSystemStatsStateForTest,
  type BridgeProcessInfo,
} from "../src/remote/system-stats";

// --- Real command outputs (sampled 2026-10-04, macOS 15.8 / M2 Pro) ---------

const VM_STAT_OUT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                7061.
Pages active:                            325902.
Pages inactive:                           310694.
Pages speculative:                         14767.
Pages throttled:                              0.
Pages wired down:                         145731.
Pages purgeable:                           2143.
`;

const SWAP_OUT = "vm.swapusage: total = 2048.00M  used = 933.06M  free = 1114.94M  (encrypted)";

const BATT_DISCHARGING = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=21758051)\t87%; discharging; 0:52 remaining present: true
`;

const BATT_NO_ESTIMATE = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=21758051)\t90%; charging; (no estimate) present: true
`;

const BATT_NONE = "No batteries available.\n";

const THERM_QUIET = `Note: No thermal warning level has been recorded
Note: No performance warning level has been recorded
`;

const THERM_LIMITED = "CPU_Speed_Limit = 50\n";

const ASSERTIONS_OUT = `Assertion status system-wide:
   BackgroundTask                 0
   UserIsActive                   0
   PreventUserIdleSystemSleep     1
Listed by owning process:
   pid 88971(Amphetamine): [0x0006f91d0001a6d1] 01:49:14 PreventUserIdleSystemSleep named: "Amphetamine (Single-Use - System)"
No kernel assertions.
`;

const NETSTAT_HEADER =
  "Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll";

function netstatRow(name: string, ibytes: number, obytes: number): string {
  return `${name}        1500  <Link#4>    aa:bb:cc:dd:ee:ff        7     0 ${String(
    ibytes,
  ).padStart(11)} ${String(obytes).padStart(7)}     0 ${String(obytes).padStart(11)}     0`;
}

const HW_PORTS_OUT = `Hardware Port: Ethernet Adapter (en4)
Device: en4
Ethernet Address: 8a:2e:c3:59:e8:b6

Hardware Port: Wi-Fi
Device: en0
Ethernet Address: 6c:7e:67:c4:1d:44
`;

const AIRPORT_OUT = "Current Wi-Fi Network: HomeNet-5G\n";

const SW_VERS_OUT = `ProductName:\t\tmacOS
ProductVersion:\t\t15.8
BuildVersion:\t\t24H23
`;

const PS_OUT = `  123 4.2 345672
  456 0.0 102400
`;

// --- Fixtures wiring ---------------------------------------------------------

const FIXTURES = new Map<string, string>([
  ["vm_stat", VM_STAT_OUT],
  ["sw_vers", SW_VERS_OUT],
  ["sysctl -n hw.model", "Mac14,9\n"],
  ["sysctl vm.swapusage", SWAP_OUT],
  ["pmset -g batt", BATT_DISCHARGING],
  ["pmset -g therm", THERM_QUIET],
  ["pmset -g assertions", ASSERTIONS_OUT],
  ["networksetup -listallhardwareports", HW_PORTS_OUT],
  ["networksetup -getairportnetwork en0", AIRPORT_OUT],
  ["ps", PS_OUT],
  ["netstat -ib", [NETSTAT_HEADER, netstatRow("en0", 0, 0)].join("\n")],
]);

/** Answer execFile from FIXTURES; unknown command or `failAll` → callback error. */
function execFromFixtures(failAll = false): void {
  execFileMock.mockImplementation(
    (
      file: string,
      args: string[],
      _opts: unknown,
      cb: (err: unknown, result: { stdout: Buffer; stderr: Buffer }) => void,
    ) => {
      // `ps` carries variable pids in its args — key on the command alone.
      const key = failAll ? "" : file === "ps" ? "ps" : [file, ...args].join(" ");
      const out = FIXTURES.get(key);
      setImmediate(() =>
        out !== undefined
          ? cb(null, { stdout: Buffer.from(out), stderr: Buffer.alloc(0) })
          : cb(new Error("denied"), { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
      );
    },
  );
}

const TWO_CPUS = (idle: number, busy: number) => [
  {
    model: "Apple M2 Pro",
    times: { user: busy, nice: 0, sys: busy, idle, irq: 0 },
  },
  {
    model: "Apple M2 Pro",
    times: { user: busy, nice: 0, sys: busy, idle, irq: 0 },
  },
];

const BRIDGES: BridgeProcessInfo[] = [
  { id: "inst-a", pid: 123, workspace: "/Users/william/Develop/tools/zcode-acp-server" },
  { id: "inst-b", pid: 456, workspace: null },
  { id: "inst-gone", pid: null, workspace: "/gone" },
];

const HUB_META = { version: "0.61.0", instances: 3 };

beforeEach(() => {
  resetSystemStatsStateForTest();
  execFileMock.mockReset();
  statfsMock.mockReset();
  vi.restoreAllMocks();
  FIXTURES.set("netstat -ib", [NETSTAT_HEADER, netstatRow("en0", 0, 0)].join("\n"));
});

// --- Parsers ------------------------------------------------------------------

describe("parsers", () => {
  test("vm_stat: page size + availability pages", () => {
    const pages = parseVmStatOutput(VM_STAT_OUT);
    expect(pages).toEqual({
      pageSizeBytes: 16384,
      free: 7061,
      speculative: 14767,
      inactive: 310694,
      purgeable: 2143,
    });
    expect(parseVmStatOutput("garbage")).toBeNull();
  });

  test("swap usage", () => {
    expect(parseSwapUsage(SWAP_OUT)).toEqual({
      totalBytes: 2048 * 1024 * 1024,
      usedBytes: 933.06 * 1024 * 1024,
    });
    expect(parseSwapUsage("vm.swapusage: total = 0.00M")).toBeNull();
  });

  test("battery: discharging with remaining time", () => {
    expect(parsePmsetBattery(BATT_DISCHARGING)).toEqual({
      present: true,
      percent: 87,
      powerSource: "battery",
      status: "discharging",
      remainingMin: 52,
    });
  });

  test("battery: charging without estimate", () => {
    expect(parsePmsetBattery(BATT_NO_ESTIMATE)).toEqual({
      present: true,
      percent: 90,
      powerSource: "ac",
      status: "charging",
      remainingMin: null,
    });
  });

  test("battery: desktop without battery", () => {
    const batt = parsePmsetBattery(BATT_NONE);
    expect(batt.present).toBe(false);
    expect(batt.percent).toBeNull();
    expect(batt.powerSource).toBeNull();
  });

  test("therm: quiet notes → null, speed limit → value", () => {
    expect(parsePmsetTherm(THERM_QUIET)).toBeNull();
    expect(parsePmsetTherm(THERM_LIMITED)).toBe(50);
  });

  test("sleep assertions: active flag + deduped holders", () => {
    expect(parseSleepAssertions(ASSERTIONS_OUT)).toEqual({
      active: true,
      holders: ["Amphetamine"],
    });
    expect(parseSleepAssertions("Assertion status system-wide:\n")).toEqual({
      active: null,
      holders: [],
    });
  });

  test("netstat: sums per-interface first row, skips lo0", () => {
    const out = [
      NETSTAT_HEADER,
      netstatRow("lo0", 1000, 1000),
      netstatRow("lo0", 1000, 1000), // address-family repeat must not double-count
      netstatRow("en0", 100_000, 40_000),
      netstatRow("en1", 500, 100),
    ].join("\n");
    expect(parseNetstatIfaceBytes(out)).toEqual({ rx: 100_500, tx: 40_100 });
    expect(parseNetstatIfaceBytes(NETSTAT_HEADER)).toBeNull();
  });

  test("Wi-Fi device + SSID", () => {
    expect(parseWifiDevice(HW_PORTS_OUT)).toBe("en0");
    expect(parseWifiDevice("Hardware Port: Thunderbolt Bridge\nDevice: bridge0\n")).toBeNull();
    expect(parseAirportNetwork(AIRPORT_OUT)).toBe("HomeNet-5G");
    expect(parseAirportNetwork("<networksetup: You are not associated")).toBeNull();
  });
});

// --- Collector ------------------------------------------------------------------

describe("collectSystemStats", () => {
  function stubNodeApis(): void {
    vi.spyOn(os, "hostname").mockReturnValue("MBP14WW.local");
    vi.spyOn(os, "uptime").mockReturnValue(1_234_567);
    vi.spyOn(os, "loadavg").mockReturnValue([1.5, 2.25, 2.5]);
    vi.spyOn(os, "totalmem").mockReturnValue(34_359_738_368);
    vi.spyOn(os, "freemem").mockReturnValue(1_048_576);
    vi.spyOn(os, "networkInterfaces").mockReturnValue([
      [
        {
          family: "IPv4",
          address: "192.168.1.5",
          netmask: "255.255.255.0",
          mac: "a:b:c",
          internal: false,
          cidr: null,
        },
        {
          family: "IPv6",
          address: "fe80::1",
          netmask: "ffff:ffff:ffff:ffff::",
          mac: "a:b:c",
          internal: false,
          cidr: null,
          scopeid: 1,
        },
        {
          family: "IPv4",
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          mac: "a:b:c",
          internal: true,
          cidr: null,
        },
      ],
    ] as ReturnType<typeof os.networkInterfaces>);
  }

  function stubCpus(idle: number, busy: number): void {
    vi.spyOn(os, "cpus").mockReturnValue(TWO_CPUS(idle, busy) as unknown as os.CpuInfo[]);
  }

  function stubStatfs(rootAndHomeSame = true): void {
    statfsMock.mockImplementation(async (p: string) =>
      Promise.resolve(
        p === "/"
          ? {
              bsize: 4096,
              blocks: 244_108_596,
              bfree: 90_000_000,
              bavail: 90_000_000,
              files: 100,
              ffree: 100,
              type: 0,
            }
          : rootAndHomeSame
            ? {
                bsize: 4096,
                blocks: 244_108_596,
                bfree: 90_000_000,
                bavail: 90_000_000,
                files: 100,
                ffree: 100,
                type: 0,
              }
            : {
                bsize: 4096,
                blocks: 1_000_000,
                bfree: 100_000,
                bavail: 100_000,
                files: 10,
                ffree: 10,
                type: 0,
              },
      ),
    );
  }

  test("first call: static fields assembled, rate fields null (no baseline)", async () => {
    execFromFixtures();
    stubNodeApis();
    stubCpus(1000, 1000);
    stubStatfs();
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);

    const stats = await collectSystemStats(BRIDGES, HUB_META);

    expect(stats.host).toEqual({
      hostname: "MBP14WW.local",
      osVersion: "15.8 (24H23)",
      model: "Mac14,9",
      chip: "Apple M2 Pro",
    });
    expect(stats.cpu).toEqual({ cores: 2, usagePct: null, loadAvg: [1.5, 2.25, 2.5] });
    // available = (7061+14767+310694+2143) pages × 16384 B
    expect(stats.memory.availableBytes).toBe(334_665 * 16384);
    expect(stats.memory.usedBytes).toBe(34_359_738_368 - 334_665 * 16384);
    expect(stats.memory.swapTotalBytes).toBe(2048 * 1024 * 1024);
    expect(stats.battery).toEqual({
      present: true,
      percent: 87,
      powerSource: "battery",
      status: "discharging",
      remainingMin: 52,
    });
    expect(stats.power).toEqual({
      preventSleep: true,
      sleepHolders: ["Amphetamine"],
      cpuSpeedLimitPct: null,
    });
    expect(stats.network).toEqual({
      addresses: ["192.168.1.5"],
      ssid: "HomeNet-5G",
      rxBytesPerS: null,
      txBytesPerS: null,
    });
    expect(stats.storage.root).not.toBeNull();
    expect(stats.storage.home).toBeNull(); // same volume as root → omitted
    expect(stats.processes.hub.rssBytes).toBeGreaterThan(0);
    expect(stats.processes.hub.cpuPct).toBeNull();
    expect(stats.processes.bridges).toEqual([
      {
        id: "inst-a",
        workspace: "/Users/william/Develop/tools/zcode-acp-server",
        pid: 123,
        rssBytes: 345672 * 1024,
        cpuPct: 4.2,
      },
      { id: "inst-b", workspace: null, pid: 456, rssBytes: 102400 * 1024, cpuPct: 0 },
      { id: "inst-gone", workspace: "/gone", pid: null, rssBytes: null, cpuPct: null },
    ]);
    expect(stats.hub).toEqual({ version: "0.61.0", uptimeS: expect.any(Number), instances: 3 });
  });

  test("second call after the rate window: deltas become real", async () => {
    execFromFixtures();
    stubNodeApis();
    stubCpus(1000, 1000);
    stubStatfs();
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    await collectSystemStats(BRIDGES, HUB_META);

    // 2s later: per core idle +1s, busy(user+sys) +3s → total Δ 4000/core,
    // idle Δ 2000 → 75% busy; net counters +100KB/50KB → 50KB/s / 25KB/s.
    stubCpus(2000, 2500);
    FIXTURES.set("netstat -ib", [NETSTAT_HEADER, netstatRow("en0", 100_000, 50_000)].join("\n"));
    execFromFixtures();
    vi.spyOn(Date, "now").mockReturnValue(1_002_000);
    const stats = await collectSystemStats(BRIDGES, HUB_META);

    expect(stats.cpu.usagePct).toBe(75);
    expect(stats.network.rxBytesPerS).toBe(50_000);
    expect(stats.network.txBytesPerS).toBe(25_000);
    expect(stats.processes.hub.cpuPct).not.toBeNull();
  });

  test("collect cache: a second call inside the TTL returns the same snapshot", async () => {
    execFromFixtures();
    stubNodeApis();
    stubCpus(1000, 1000);
    stubStatfs();
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const first = await collectSystemStats(BRIDGES, HUB_META);

    vi.spyOn(Date, "now").mockReturnValue(1_000_500);
    const second = await collectSystemStats(BRIDGES, HUB_META);
    expect(second).toBe(first);
  });

  test("every subprocess denied: fields degrade to null, nothing throws", async () => {
    execFromFixtures(true);
    stubNodeApis();
    stubCpus(1000, 1000);
    statfsMock.mockRejectedValue(new Error("denied"));
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);

    const stats = await collectSystemStats(BRIDGES, HUB_META);

    expect(stats.host.osVersion).toBeNull(); // sw_vers denied
    expect(stats.memory.availableBytes).toBe(1_048_576); // vm_stat denied → os.freemem()
    expect(stats.memory.swapTotalBytes).toBeNull();
    expect(stats.battery.present).toBe(false);
    expect(stats.power).toEqual({ preventSleep: null, sleepHolders: [], cpuSpeedLimitPct: null });
    expect(stats.network.ssid).toBeNull();
    expect(stats.storage.root).toBeNull();
    expect(stats.processes.bridges.map((b) => b.rssBytes)).toEqual([null, null, null]); // ps denied
  });
});
