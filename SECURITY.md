# Security Policy

## What This Project Touches

This is a stdio ACP bridge — no network listener. It does not implement its
own authentication logic or validate credentials; it advertises an agent-type
`authMethods` entry in its `initialize` response so editors know auth is
self-handled, and reads the GLM key from `~/.zcode/v2/config.json`. In order
to bridge the headless ZCode CLI to ACP-compatible editors, it does read and
write a small number of sensitive files owned by the ZCode app:

| Path                             | Read/Write     | What it touches                                                                                                                                                                                                                                                                                                       |
| -------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.zcode/v2/config.json`        | read           | Reads the active provider's `baseURL` and `apiKey` (in `backend/credentials.ts`) and the model list (in `config/options.ts`, `config/runtime-model.ts`). The `apiKey` is forwarded to the ZCode subprocess via an environment variable (`ANTHROPIC_API_KEY`) and is never written to logs, stdout, or any other file. |
| `~/.zcode/v2/tasks-index.sqlite` | **read/write** | Inserts/updates rows in the `tasks` table (`tasks-index.ts`) so that sessions created via ACP appear in the ZCode app's UI. Only the `tasks` table is touched, using `INSERT OR IGNORE` / bounded `UPDATE`.                                                                                                           |

The bridge does **not**:

- send credentials, tokens, or session data anywhere except the local ZCode subprocess;
- modify the ZCode CLI binary, the app, or any file outside `tasks-index.sqlite`;
- expose any network port.

## Reporting a Vulnerability

If you find a way this bridge leaks credentials, corrupts the tasks-index, or
escapes its stdio boundary, please report it privately rather than opening a
public issue:

- Open a private security advisory via GitHub's
  [Report a vulnerability](https://github.com/william0wang/zcode-acp/security/advisories/new),
  or
- email the maintainer (see the GitHub profile).

Please include the affected file/line, a description of impact, and a
reproduction if possible. You should hear back within **72 hours**.

## Out of Scope

Report these to the upstreams, not here:

- The ZCode CLI itself, the ZCode app, or the `config.json` format — these
  are owned by [Zhipu Z.AI](https://z.ai).
- The editor (Zed, JetBrains) or the ACP specification.
- Issues that require already having code execution on the host.
