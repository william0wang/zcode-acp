/**
 * /auto slash-parse tests: the first word is a subcommand ONLY when it is
 * exactly pause|stop|resume|status — anything else is the objective in full.
 * Pins the regression where every objective silently lost its first word and
 * objectives starting with a keyword misfired as subcommands. Also pins that
 * /goal (restored backend mode) forwards action=set to session/goal.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

import type * as acp from "@agentclientprotocol/sdk";

const startMock = vi.fn();
const pauseMock = vi.fn();
const resumeMock = vi.fn();
const stopMock = vi.fn();
const liveMock = vi.fn();
const goalBackendMock = vi.fn();

vi.mock("../src/goal-loop/driver.js", () => ({
  GoalLoopDriver: {
    start: (...args: unknown[]) => startMock(...(args as [])),
    live: (...args: unknown[]) => liveMock(...(args as [])),
  },
}));
vi.mock("../src/goal-loop/state.js", () => ({
  readGoalState: vi.fn(() => null),
}));
vi.mock("../src/handlers/extensions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/handlers/extensions.js")>()),
  goal: (...args: unknown[]) => goalBackendMock(...(args as [])),
}));

import { handleSlashCommand } from "../src/handlers/slash.js";
import { ZcodeAcpServer } from "../src/server.js";

const SID = "sess_goal";

/** Mock AgentContext that records notify calls (feedback chunks land there). */
function mockContext(): { cx: acp.AgentContext; sent: unknown[] } {
  const sent: unknown[] = [];
  const cx = {
    notify(_method: string, params: { update: unknown }) {
      sent.push(params.update);
      return Promise.resolve();
    },
  } as unknown as acp.AgentContext;
  return { cx, sent };
}

function liveDriver(): object {
  return {
    pause: pauseMock,
    resume: resumeMock,
    stop: stopMock,
    statusText: () => "goal loop: running · 1/100 rounds",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  liveMock.mockReturnValue(undefined);
  goalBackendMock.mockResolvedValue({});
});

describe("/auto argument parsing", () => {
  it("passes the FULL objective to start (no first-word truncation)", async () => {
    const { cx } = mockContext();
    const server = new ZcodeAcpServer();
    const result = await handleSlashCommand(server, cx, SID, SID, "/auto make tests pass");

    expect(result?.stopReason).toBe("end_turn");
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(startMock.mock.calls[0]!.slice(0, 4)).toEqual([server, SID, SID, "make tests pass"]);
  });

  it("treats a single-word objective as the objective, not a subcommand miss", async () => {
    const { cx } = mockContext();
    const server = new ZcodeAcpServer();
    await handleSlashCommand(server, cx, SID, SID, "/auto refactor");
    expect(startMock).toHaveBeenCalledWith(server, SID, SID, "refactor");
  });

  it("still routes the exact keywords to their subcommands", async () => {
    const { cx } = mockContext();
    const server = new ZcodeAcpServer();
    liveMock.mockReturnValue(liveDriver());

    await handleSlashCommand(server, cx, SID, SID, "/auto pause");
    expect(pauseMock).toHaveBeenCalledTimes(1);
    expect(startMock).not.toHaveBeenCalled();

    await handleSlashCommand(server, cx, SID, SID, "/auto stop");
    expect(stopMock).toHaveBeenCalledTimes(1);

    const status = await handleSlashCommand(server, cx, SID, SID, "/auto status");
    expect(status?.stopReason).toBe("end_turn");
    expect(startMock).not.toHaveBeenCalled();
  });

  it("documented trade-off: an objective starting with a keyword fires the subcommand", async () => {
    const { cx } = mockContext();
    const server = new ZcodeAcpServer();
    liveMock.mockReturnValue(liveDriver());
    // "stop the flaky test" cannot be expressed as an objective — /auto stop
    // wins. Documented in slash.ts; preferable to truncating every objective.
    await handleSlashCommand(server, cx, SID, SID, "/auto stop the flaky test");
    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(startMock).not.toHaveBeenCalled();
  });

  it("/auto resume on a live driver clears its pending pause instead of swallowing it", async () => {
    const { cx } = mockContext();
    const server = new ZcodeAcpServer();
    // A paused-but-still-registered driver: its round has not hit the
    // boundary yet, so the resume must go to resume(), not start().
    liveMock.mockReturnValue(liveDriver());

    const result = await handleSlashCommand(server, cx, SID, SID, "/auto resume");

    expect(result?.stopReason).toBe("end_turn");
    expect(resumeMock).toHaveBeenCalledTimes(1);
    expect(startMock).not.toHaveBeenCalled();
  });
});

describe("/goal backend mode", () => {
  it("forwards the objective as action=set to the backend goal()", async () => {
    const { cx } = mockContext();
    const server = new ZcodeAcpServer();
    const result = await handleSlashCommand(server, cx, SID, SID, "/goal ship the release");

    expect(result?.stopReason).toBe("end_turn");
    expect(goalBackendMock).toHaveBeenCalledTimes(1);
    expect(goalBackendMock).toHaveBeenCalledWith(server, {
      sessionId: SID,
      action: "set",
      objective: "ship the release",
    });
    expect(startMock).not.toHaveBeenCalled();
  });

  it("rejects /goal without an argument", async () => {
    const { cx } = mockContext();
    const server = new ZcodeAcpServer();
    await expect(handleSlashCommand(server, cx, SID, SID, "/goal")).rejects.toThrow();
    expect(goalBackendMock).not.toHaveBeenCalled();
  });
});
