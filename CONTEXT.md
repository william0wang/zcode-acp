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
The editor connection over stdio that spawned the bridge and owns its
lifetime (Zed, JetBrains). When it disconnects, the bridge exits.
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

**Instance**:
One registered bridge as seen through the Hub. A remote connection binds to
exactly one instance; instance switching means reconnecting.
_Avoid_: agent, server, worker
