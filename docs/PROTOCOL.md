# ZCode JSON-RPC Protocol

This document describes the internal JSON-RPC protocol between zcode-acp-server
and the ZCode CLI.

## Protocol Overview

ZCode communicates over stdio using **line-delimited JSON**. The message format
resembles JSON-RPC, but **does not include the `jsonrpc` field**.

### Message classification

Messages are classified by the presence of `id` and `method`:

| Combination | Type | Direction |
|------|------|------|
| `id` + no `method` | Response | zcode -> bridge |
| `id` + `method` | Request | bridge -> zcode or zcode -> bridge |
| `method` + no `id` | Notification | bidirectional |

### Request format

```json
{
  "id": 1,
  "method": "session/create",
  "params": {
    "workspace": {
      "workspacePath": "/path/to/project",
      "workspaceKey": "/path/to/project"
    },
    "mode": "yolo"
  }
}
```

### Response format

```json
{
  "id": 1,
  "result": {
    "session": {
      "sessionId": "sess_abc123",
      "title": "your prompt text..."
    }
  }
}
```

### Error format

```json
{
  "id": 1,
  "error": {
    "message": "prompt is running",
    "code": 1308
  }
}
```

### Notification format

```json
{
  "method": "session/event",
  "params": {
    "sessionId": "sess_abc123",
    "seq": 42,
    "type": "turn.started",
    "payload": {}
  }
}
```

## Session Lifecycle Methods

### `session/create`

Create a new session.

**Request:**
```json
{
  "id": 1,
  "method": "session/create",
  "params": {
    "workspace": {
      "workspacePath": "/path/to/project",
      "workspaceKey": "/path/to/project"
    },
    "mode": "yolo"
  }
}
```

**Response:**
```json
{
  "id": 1,
  "result": {
    "session": {
      "sessionId": "sess_abc123",
      "title": "",
      "traceId": "trace_xyz789"
    }
  }
}
```

### `session/list`

List all sessions.

**Request:**
```json
{
  "id": 2,
  "method": "session/list",
  "params": {
    "workspace": {
      "workspacePath": "/path/to/project",
      "workspaceKey": "/path/to/project"
    }
  }
}
```

### `session/resume`

Resume an existing session.

**Request:**
```json
{
  "id": 3,
  "method": "session/resume",
  "params": {
    "sessionId": "sess_abc123",
    "workspace": {
      "workspacePath": "/path/to/project",
      "workspaceKey": "/path/to/project"
    }
  }
}
```

### `session/send`

Send a prompt.

**Request:**
```json
{
  "id": 4,
  "method": "session/send",
  "params": {
    "sessionId": "sess_abc123",
    "content": "your prompt text"
  }
}
```

**Response:**
```json
{
  "id": 4,
  "result": {
    "accepted": true
  }
}
```

### `session/stop`

Stop the current turn (fire-and-forget).

```json
{
  "method": "session/stop",
  "params": {
    "sessionId": "sess_abc123"
  }
}
```

### `session/read`

Read the session state and projection.

**Request:**
```json
{
  "id": 5,
  "method": "session/read",
  "params": {
    "sessionId": "sess_abc123"
  }
}
```

**Response:**
```json
{
  "id": 5,
  "result": {
    "projection": {
      "status": "idle",
      "contextUsed": 1234,
      "contextWindow": 32000,
      "totalTokenCount": 5678
    },
    "settings": {
      "mode": { "current": "yolo" },
      "model": { "current": { "modelId": "GLM-5.2" } },
      "thoughtLevel": { "current": "high" }
    },
    "todos": [
      { "content": "Implement login", "status": "pending", "priority": "high" }
    ]
  }
}
```

### `session/messages`

Fetch the session's historical messages.

**Request:**
```json
{
  "id": 6,
  "method": "session/messages",
  "params": {
    "sessionId": "sess_abc123"
  }
}
```

## Event Stream Subscription

### `session/subscribe`

Subscribe to a session's event push.

**Request:**
```json
{
  "id": 7,
  "method": "session/subscribe",
  "params": {
    "sessionId": "sess_abc123",
    "deliveryKind": "desktop-continuous",
    "includeSnapshot": true,
    "afterSeq": 0
  }
}
```

**Response:**
```json
{
  "id": 7,
  "result": {
    "eventSeq": 42,
    "snapshot": {
      "projection": { ... },
      "messages": [ ... ]
    }
  }
}
```

## Event Types

After subscribing, zcode pushes events via `session/event` notifications:

### `turn.started`

The turn has started.

```json
{
  "method": "session/event",
  "params": {
    "sessionId": "sess_abc123",
    "seq": 43,
    "type": "turn.started",
    "payload": {}
  }
}
```

### `model.streaming`

Model streaming output.

```json
{
  "method": "session/event",
  "params": {
    "sessionId": "sess_abc123",
    "seq": 44,
    "type": "model.streaming",
    "payload": {
      "kind": "text_delta",
      "delta": "this code..."
    }
  }
}
```

`kind` can be:
- `text_delta`: text delta
- `reasoning_delta`: reasoning text delta
- `tool_call`: tool call declaration (caches toolName and input)

### `tool.updated`

Tool status update.

```json
{
  "method": "session/event",
  "params": {
    "sessionId": "sess_abc123",
    "seq": 45,
    "type": "tool.updated",
    "payload": {
      "kind": "scheduled",
      "toolCallId": "call_xyz",
      "toolName": "Bash",
      "input": { "command": "ls -la" }
    }
  }
}
```

`kind` can be:
- `scheduled`: tool scheduled
- `started`: tool started executing
- `progress`: progress update (stdoutTail / stderrTail)
- `result`: tool finished
- `error`: tool error
- `batch`: multiple tools finished in a batch

### `turn.completed`

The turn completed.

```json
{
  "method": "session/event",
  "params": {
    "sessionId": "sess_abc123",
    "seq": 46,
    "type": "turn.completed",
    "payload": {
      "resultType": "success",
      "usage": {
        "totalTokens": 1234
      }
    }
  }
}
```

### `turn.failed`

The turn failed.

```json
{
  "method": "session/event",
  "params": {
    "sessionId": "sess_abc123",
    "seq": 47,
    "type": "turn.failed",
    "payload": {
      "error": {
        "code": 1308,
        "message": "prompt is running"
      }
    }
  }
}
```

### `session.updated`

Session state update (usage, etc.).

```json
{
  "method": "session/event",
  "params": {
    "sessionId": "sess_abc123",
    "seq": 48,
    "type": "session.updated",
    "payload": {
      "usage": {
        "inputTokens": 1234
      },
      "contextWindow": 32000
    }
  }
}
```

### Steer lifecycle events

When `session/steer` appends instructions to a running turn, the backend emits
a pair of lifecycle events (available in app-server 0.15.2+). The bridge does
not currently translate these — they are tracked as a future enhancement (see
[`BACKLOG.md`](./BACKLOG.md)).

```json
{
  "type": "turn.steerQueued",
  "payload": {}
}
```

```json
{
  "type": "turn.steerDrained",
  "payload": {}
}
```

### `turn.terminal`

Terminal turn lifecycle event (app-server 0.15.2+). Carries a status plus
usage. The bridge currently relies on `turn.completed`/`turn.failed` instead;
documented here for completeness.

```json
{
  "method": "session/event",
  "params": {
    "sessionId": "sess_abc123",
    "seq": 49,
    "type": "turn.terminal",
    "payload": {
      "kind": "turn.terminal",
      "status": "success",
      "resultType": "end_turn",
      "durationMs": 12345,
      "inputTokens": 1234,
      "outputTokens": 567,
      "totalTokens": 1801
    }
  }
}
```

## Interaction Protocol (Server -> Client)

Requests that zcode actively sends to the bridge.

### `interaction/requestPermission`

Tool permission request.

```json
{
  "id": 100,
  "method": "interaction/requestPermission",
  "params": {
    "requestId": "req_xyz",
    "sessionId": "sess_abc123",
    "toolCallId": "call_xyz",
    "toolName": "Bash",
    "reason": "run command",
    "input": { "command": "rm -rf /" },
    "options": [
      { "optionId": "allow", "kind": "allow_once", "name": "Allow once" },
      { "optionId": "deny", "kind": "deny_once", "name": "Deny" }
    ]
  }
}
```

### `interaction/requestUserInput`

User input request (ExitPlanMode / AskUserQuestion).

**ExitPlanMode:**
```json
{
  "id": 101,
  "method": "interaction/requestUserInput",
  "params": {
    "requestId": "req_xyz",
    "sessionId": "sess_abc123",
    "toolCallId": "call_xyz",
    "schema": { "interaction": "plan_approval" },
    "input": { "plan": "1. Implement login\n2. Implement signup" }
  }
}
```

**AskUserQuestion:**
```json
{
  "id": 102,
  "method": "interaction/requestUserInput",
  "params": {
    "requestId": "req_xyz",
    "sessionId": "sess_abc123",
    "toolCallId": "call_xyz",
    "questions": [
      {
        "question": "Select the files to test",
        "multiSelect": true,
        "options": [
          { "label": "auth.test.ts", "value": "auth" },
          { "label": "user.test.ts", "value": "user" }
        ]
      }
    ]
  }
}
```

### Bridge routing (protocol negotiation)

ZCode `interaction/*` requests are routed to different ACP interaction
mechanisms based on client capabilities:

| Request type | Client supports elicitation.form | Client does not |
|---------|:------------------------:|:----------:|
| Tool auth (`interaction/requestPermission`) | `session/request_permission` | `session/request_permission` |
| ExitPlanMode (`interaction/requestUserInput` + plan_approval) | `elicitation/create` (approve/reject form) | `session/request_permission` |
| AskUserQuestion (`interaction/requestUserInput`) | `elicitation/create` (single form) | per-question `session/request_permission` |

**Capability detection**: at `initialize` time the client declares support via
`clientCapabilities.elicitation.form`. The server detects it with
`server.supportsElicitationForm()`.

**elicitation form example** (AskUserQuestion):
```json
{
  "method": "elicitation/create",
  "params": {
    "mode": "form",
    "sessionId": "sess_abc123",
    "message": "Please answer 2 questions.",
    "requestedSchema": {
      "type": "object",
      "properties": {
        "q_0": {
          "type": "string",
          "title": "Select the files to test",
          "oneOf": [
            { "const": "auth.test.ts", "title": "auth.test.ts" },
            { "const": "user.test.ts", "title": "user.test.ts" },
            { "const": "__skip__", "title": "Skip this question" }
          ]
        },
        "q_0_other": {
          "type": "string",
          "title": "↳    or type a custom value (overrides the selection)"
        }
      },
      "required": []
    }
  }
}
```

ACP/MCP elicitation string fields are EITHER an enum (restricted dropdown) OR
free text — the spec forbids a single field that is both. So each question is
rendered as TWO fields: `q_<i>` (a `oneOf`/`anyOf` enum dropdown of the model's
suggested answers, with a trailing "Skip this question" option whose `const` is
the `__skip__` sentinel and whose `title` is the readable label) and
`q_<i>_other` (a free-text companion). On submit, a non-empty `q_<i>_other`
overrides the dropdown (single-select) or is appended to the picked values
(multi-select); selecting "Skip this question" or leaving both blank skips just
that question without cancelling the form.

**elicitation response** (accept/decline/cancel):
```json
{
  "action": "accept",
  "content": { "q_0": "auth.test.ts" }
}
```

**ExitPlanMode elicitation form** — single `feedback` text field; no
approve/reject dropdown. The client's own submit button is the approve action;
typing into the field is the reject action. Submitting with the field empty
approves the plan; submitting with text rejects it and returns the text to
zcode as the decline `reason` (so the agent sees the redirection when it
re-plans). The cancel/decline button is a plain reject with no reason.
```json
{
  "method": "elicitation/create",
  "params": {
    "mode": "form",
    "sessionId": "sess_abc123",
    "message": "Ready to code?\n\n1. Implement login\n2. Implement signup\n\nLeave the box empty and submit to approve; type feedback to reject and redirect.",
    "requestedSchema": {
      "type": "object",
      "properties": {
        "feedback": {
          "type": "string",
          "title": "Feedback",
          "description": "Empty = approve the plan. Anything typed = reject and use this text as the redirection."
        }
      },
      "required": []
    }
  }
}
```

## Extension Methods (0.14.8+)

### `session/fork`

Fork a new session from a checkpoint.

**Request:**
```json
{
  "id": 8,
  "method": "session/fork",
  "params": {
    "sessionId": "sess_abc123",
    "target": { "kind": "latestCheckpoint" }
  }
}
```

### `session/rewind`

Rewind to a checkpoint.

**Request:**
```json
{
  "id": 9,
  "method": "session/rewind",
  "params": {
    "sessionId": "sess_abc123",
    "target": { "kind": "latestCheckpoint" },
    "expectedRevision": 42
  }
}
```

### `session/goal`

Read / set / replace / clear the goal.

**Request:**
```json
{
  "id": 10,
  "method": "session/goal",
  "params": {
    "sessionId": "sess_abc123",
    "action": "set",
    "objective": "Refactor the auth module"
  }
}
```

`action` can be: `show`, `set`, `replace`, `clear`, `pause`, `resume`

### `session/compact`

Compact the conversation history.

**Request:**
```json
{
  "id": 11,
  "method": "session/compact",
  "params": {
    "sessionId": "sess_abc123"
  }
}
```

### `session/steer`

Append instructions to a running turn.

**Request:**
```json
{
  "id": 12,
  "method": "session/steer",
  "params": {
    "sessionId": "sess_abc123",
    "content": "Please use TypeScript instead of JavaScript"
  }
}
```

### `session/setMode`

Switch the session mode.

**Request:**
```json
{
  "id": 13,
  "method": "session/setMode",
  "params": {
    "sessionId": "sess_abc123",
    "mode": "build"
  }
}
```

### `session/setThoughtLevel`

Set the thought level.

**Request:**
```json
{
  "id": 14,
  "method": "session/setThoughtLevel",
  "params": {
    "sessionId": "sess_abc123",
    "thoughtLevel": "max"
  }
}
```

## Background Tasks & Sub-Agents

When the model dispatches a sub-agent via the `Agent` (or `Task`) tool, the
backend keeps producing events on the **same session stream** — both while the
sub-agent runs and after the main turn ends. The bridge forwards a curated
subset to the ACP client:

### Synchronous sub-agent (blocking)

The `Agent` tool blocks until the sub-agent finishes. Its internal tool calls
(`Read`, `Bash`, …) arrive as ordinary `tool.updated` events on the main stream
and are forwarded as regular `tool_call` cards. The `Agent` card itself carries
structured metadata in `_meta.subagent` (parsed from the result content):

```json
{
  "sessionUpdate": "tool_call_update",
  "toolCallId": "call_xxx",
  "status": "completed",
  "_meta": {
    "claudeCode": { "toolName": "Agent" },
    "subagent": {
      "agentId": "agent_73c7c63d-...",
      "tokens": 40904,
      "toolUses": 1,
      "durationMs": 10559
    }
  }
}
```

### Background sub-agent (`run_in_background: true`)

The `Agent` tool returns immediately with a launch acknowledgement (result
content contains `agentId` + `output_file` + "working in the background"). The
main turn then completes, but the backend continues to push the task's
lifecycle on the same stream:

**1. Status changes** — `session.updated` carries a `taskId` and `status`:

```json
{
  "method": "session/event",
  "params": {
    "sessionId": "sess_abc123",
    "seq": 16,
    "type": "session.updated",
    "payload": {
      "taskId": "agent_88a44529-...",
      "toolCallId": "call_orig",
      "toolName": "Agent",
      "status": "running",
      "description": "Read README first heading",
      "outputPath": "/.../output.txt",
      "terminalId": "agent_88a44529-...",
      "startedAt": "2026-07-18T09:06:45.929Z"
    }
  }
}
```

The bridge's session-scoped `BackgroundTaskListener` turns these into a
dedicated ACP tool card (`[background] <description>`) plus status updates:

| Backend event | ACP notification |
|---|---|
| first `session.updated` (status `running`) | `tool_call` (new card, `kind:"other"`, `status:"in_progress"`) |
| `session.updated` (status `completed`) | `tool_call_update` (`status:"completed"`) |

`session.updated` events WITHOUT a `taskId` (e.g. usage updates) are ignored by
the background listener — they remain owned by the turn loop.

**2. Completion notification turn** — when the background task finishes, the
backend auto-triggers a new turn whose `turn.started` carries
`inputSource:"background_task"`:

```json
{
  "type": "turn.started",
  "payload": {
    "inputSource": "background_task",
    "inputVisibility": "model-only",
    "input": "<task-notification>\n  <task-id>agent_...</task-id>\n  <status>completed</status-status>\n  ...\n</task-notification>",
    "turnId": "turn_95197b25-..."
  }
}
```

The background listener forwards that turn's `model.streaming text_delta` as
`agent_message_chunk` so the user sees the background result. The per-prompt
turn loop **defers** this entire turn (drops its events) to avoid double-
forwarding and to keep it from prematurely ending the user's real turn.

### Background Bash (`run_in_background: true`)

The `Bash` tool launched with `run_in_background: true` returns immediately
with a launch acknowledgement (result content: "Command running in background
with ID: exec_…"). Like the Agent sub-agent, the backend keeps pushing the
task's lifecycle on the same stream via `session.updated` events that carry
the originating `toolCallId`:

```json
{
  "type": "session.updated",
  "payload": {
    "taskId": "exec_ac3a5053-...",
    "toolCallId": "call_e282b4ec...",
    "toolName": "Bash",
    "status": "running",
    "pid": 22410,
    "outputPath": "/.../call_...-stdout.log",
    "outputTail": "done\n"
  }
}
```

**Card reuse, not duplication.** Unlike an Agent sub-agent (which mints a fresh
`bg_*` card), a background Bash task **reuses the launch card** — the very
terminal card the dispatcher created when `Bash` was scheduled. This keeps the
lifecycle on a single card instead of producing a duplicate `[background]` card
that the editor would show alongside the closed launch card.

The mechanism:

1. **Launch turn** — the dispatcher tags the `ToolCallNew`/`ToolCallUpdate`
   with `background: true` (threaded from the cached `input.run_in_background`
   flag) and, on the launch `result`, **skips `terminal_exit`** so the launch
   card stays `in_progress`. It seeds an empty marker in `terminalSentData`
   for the `toolCallId` — this is the signal the background listener uses to
   recognise "this is a tracked launch card".
2. **Lifecycle (`session.updated`)** — the `BackgroundTaskListener` resolves
   the `toolCallId`, sees it in `terminalSentData`, and routes status updates
   back to the launch card. On `status:"completed"`, it emits the final
   `outputTail` via `terminal_output` (iff launch text wasn't already streamed)
   and closes the terminal UI with `terminal_exit` (exit code 0, or 1 on
   `failed`), then clears the `terminalSentData` entry.
3. **Fallback** — if the `session.updated` lacks a `toolCallId`, or the
   `toolCallId` is unknown to `terminalSentData` (sub-agent case), the listener
   falls back to minting a fresh `bg_*` card — the Agent sub-agent path above.

| Backend event | ACP notification (background Bash) |
|---|---|
| first `session.updated` (status `running`) | `tool_call_update` on the launch card (`status:"in_progress"`) |
| `session.updated` (status `completed`, with `outputTail`) | `terminal_output` (final output, if not already streamed) + `tool_call_update` with `terminal_exit` (`status:"completed"`) |
| `session.updated` (status `failed`) | `tool_call_update` with `terminal_exit` (`status:"failed"`, exit_code 1) |

`session/cancelBackgroundTask` for a background Bash task additionally emits
`terminal_exit` with `_meta.backgroundTask.cancelled = true` so the terminal
UI closes on cancellation.

### `session/cancelBackgroundTask`

Cancels a background task. The bridge additionally marks the corresponding ACP
tool card as `failed` with `_meta.backgroundTask.cancelled = true`.



| ZCode CLI version | session/subscribe | Extension methods | Notes |
|---------------|-------------------|----------|------|
| >= 0.15.0 | Supported | All supported | Full functionality |
| >= 0.14.8 | Supported | Partially supported | workspace/* unavailable |
| 0.14.5 ~ 0.14.7 | Not supported | Not supported | Incompatible with this project |

## Additional backend methods (not wired into the bridge)

The backend exposes more RPC methods than the bridge uses (sub-agent listing,
event pull, session usage/close, automation, workspace config, MCP/plugins).
These have no ACP-side counterpart yet. See [`BACKLOG.md`](./BACKLOG.md) for
the full list and which are candidates for future support.
