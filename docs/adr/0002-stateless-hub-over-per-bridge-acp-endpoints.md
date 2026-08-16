# Remote access: stateless hub over per-bridge ACP endpoints

Remote clients must reach any active bridge through a single tunneled port
(Cloudflare Tunnel / frp); exposing one port per bridge does not survive that
constraint. We decided each bridge serves its own ACP endpoint on loopback
only (auto-incrementing ports from 8378), and a machine-singleton hub
(`zcode-acp-hub`, fixed port 8377, auto-spawned detached by bridges, idle-exits
after ~10 minutes without registrations) does exactly three things: token
authentication, instance discovery, and byte-level WebSocket proxying
(`WS /acp?instance=<id>` → the chosen bridge).

The hub has no ACP semantics and no business state; session authority stays
in the bridges. A remote connection binds to one instance for its whole
lifetime; switching instances means opening a new connection. We rejected a
globally-routing gateway that aggregates sessions across bridges and speaks
ACP itself — it would re-create session management outside the bridges, which
is the "fat hub" design this project deliberately avoids.

The hub is the only public entry point, so it is the only place that enforces
the token; the tunnel maps exactly this one port. WebSocket ping/pong
heartbeat (~30s) is mandatory on both hub and proxy connections because ACP
streams are silent when idle and proxy layers (notably Cloudflare) drop idle
connections.
