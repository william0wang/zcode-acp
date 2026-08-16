# Bridge lifetime follows the Primary Client

When remote access is enabled, remote clients attach to a bridge that the
Primary Client (the editor over stdio) spawned. We decided the bridge process
lives and dies with its Primary Client: when the editor disconnects, the
bridge (and every remote attachment) exits, even if remote clients are
mid-turn.

Rationale: session authority lives inside the bridge process. Keeping a
bridge alive after the editor leaves means the editor's reconnect spawns a
second bridge with its own backend subprocess, and both compete for the same
ZCode session files. Tying lifetime to the Primary Client matches the
existing mental model — the editor owns the session, remote clients are a
live window onto it.
