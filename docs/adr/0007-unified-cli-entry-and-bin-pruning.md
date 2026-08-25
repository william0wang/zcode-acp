# Unified CLI entry and bin pruning

The package grew three separate bins (`zcode-acp-server`, `zcode-acp-hub`,
`zcode-quota`) plus a planned terminal chat surface. Installing four sibling
commands for one tool is noisy, and each new surface would add another. We
decided to ship one human-facing entry point — the Unified CLI, `zcode-acp` —
with every surface as a subcommand: `quota`, `hub`, and `server`. Bare
`zcode-acp` opens the interactive REPL: an Ink-rendered chat UI (the renderer
Claude Code and Gemini CLI use) speaking ACP to a spawned bridge over stdio,
with the update pump, permission picker, and turn state machine owned by this
package. The REPL is written in-house rather than borrowed — no embeddable
interactive ACP client library exists (acpx is headless-only; the interactive
clients Toad/Hydra/Nori are external tools or heavyweight daemons), and we
control both protocol ends already.

Bin declarations are pruned to `zcode-acp` and `zcode-acp-server`. The server
bin stays because it is the command name hardcoded in existing editor configs
(Zed, JetBrains) across ~2.5k monthly downloads — removing it would break every
current user at once; it is an editor contract, not a human alias. The
`zcode-acp-hub` and `zcode-quota` bins are removed in 0.12.0 with a README
migration note (`zcode-acp hub` / `zcode-acp quota`); the hub's own binary file
stays in `dist/bin/hub.js` because bridges spawn it by absolute path, not by
command name, so the remote feature is unaffected.

Bin-name detection is `basename(argv[1])`, which works through Unix symlinks
but not through Windows `.cmd` shims (they spawn `node ...\dist\cli.js`, so
the bin name never reaches argv). Bare invocation without a TTY therefore
falls back to the stdio server — the only sensible reading of a piped, no-TTY
launch, and exactly what a Windows editor spawn needs. The explicit
`zcode-acp repl` subcommand keeps a hard TTY check and errors instead.

We rejected keeping all old bins as silent aliases (five installed commands;
the redundancy was the original complaint), removing every old bin including
`zcode-acp-server` (breaks all existing editor configs at once; revisit at
1.0), and bundling [acpx](https://github.com/openclaw/acpx) as a `chat`
passthrough subcommand (evaluated first: its engine is headless-only, so it
cannot host the interactive REPL that is the actual requirement, and keeping
it beside the in-house REPL would mean two terminal surfaces, a pre-1.0
dependency, and an extra Node engine bump for no remaining use — dropped
before release).
