# zcode-acp-server

A bridge that connects the ZCode agent backend to ACP-compatible editors. The
bridge process is the session authority; editors and remote clients attach to
it.

## Language

**Bridge**:
A running zcode-acp-server process owning one ZCode backend subprocess, the
session registry, and the turn loops. One editor connection = one bridge.
_Avoid_: server (ambiguous with the ACP agent role), hub

**Primary Client**:
The connection over stdio that spawned the bridge and owns its lifetime — an
editor (Zed, JetBrains) or the Unified CLI's REPL in a terminal.
When it disconnects, the bridge exits.
_Avoid_: host, master client

**Remote Client**:
Any additional ACP client attached over the network to watch and drive the
same sessions as the Primary Client.
_Avoid_: secondary client, web client (the web UI is just one kind)

**Session Authority**:
The property that session state (id mappings, turn loops, pending
interactions) lives inside the Bridge process, not in any client or external
store.
_Avoid_: session owner, session store

**Broadcast**:
Delivering every agent-originated notification to all attached clients
(Primary + Remote), and delivering interaction requests to all of them with
first-response-wins semantics.
_Avoid_: fan-out (fine informally, but Broadcast is the canonical term)

**Hub**:
The machine-level singleton daemon that is the only public entry point for
remote access. It does token auth, instance discovery, and byte-level
WebSocket proxying — it holds no session state and understands no ACP.
_Avoid_: gateway, broker

**Unified CLI**:
The `zcode-acp` command — the single human-facing command-line entry point.
Bare invocation opens the **REPL** (interactive agent chat in a terminal);
every other surface is a subcommand: `quota` (plan usage cards), `hub`
(running the Hub daemon), and `server` (the editor-facing bridge entry,
identical to the legacy `zcode-acp-server` bin kept for existing editor
configs).
_Avoid_: launcher, wrapper

**Instance**:
One registered bridge as seen through the Hub. A remote connection binds to
exactly one instance; instance switching means reconnecting.
_Avoid_: agent, server, worker

**Replay**:
Delivering a session's stored history to an attaching client as session/update
notifications. Serves both the initial attach and reconnect catch-up.
_Avoid_: history sync, restore, backfill

**Turn**:
One span of session history from a user message up to (not including) the next
user message. The alignment unit for replay cuts — a replay never starts
mid-turn. Leading non-user messages belong to the first turn.
_Avoid_: round, exchange, message (a turn contains many messages)

**Cursor**:
An opaque handle identifying the oldest replayed Turn, used to page further
back into history. Valid only while the history it points into is unchanged.
_Avoid_: token (collides with the auth token), offset, bookmark

**Session Root**:
The working directory (cwd) a session was created or loaded with. The scope
boundary for remote file access: a client may only read inside the Session
Root of a session it can address by session id.
_Avoid_: project (no such unit in the bridge model), workspace root (Workspace
is a display label, not a boundary)

**Workspace**:
The display label a bridge reports to the Hub for instance discovery (the
first known session cwd). Purely informational — it is not a permission
boundary and may not cover every session root on that instance.
_Avoid_: project, workspace root
