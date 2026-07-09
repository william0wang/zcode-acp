# Contributing to zcode-acp-server

Thanks for your interest in contributing! This project bridges the headless
ZCode app-server to ACP-compatible editors (Zed, JetBrains), and is released
under the Apache-2.0 license.

## Prerequisites

- Node.js **>= 22** (the bridge uses `node:sqlite` for tasks-index sync)
- pnpm (install via `corepack enable`)
- ZCode CLI >= 0.14.8 (for manual / smoke testing)

## Getting Started

```bash
git clone <repo-url>
cd zcode-acp-server
pnpm install
pnpm run build
pnpm test
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the full development guide
(debugging tips, manual testing, adding extension methods).

## Development Workflow

1. Create a branch off `main` (e.g. `feat/...`, `fix/...`).
2. Make your changes. Match the surrounding code style — the project uses
   Prettier (config in `.prettierrc.json`) and ESLint.
3. Before pushing, run:

   ```bash
   pnpm run typecheck   # tsc --noEmit
   pnpm run lint        # eslint
   pnpm run build       # tsc -> dist/
   pnpm test            # vitest run
   ```

4. Open a pull request against `main`. CI runs the same checks.

## Code Style

- **Language**: TypeScript strict mode (`tsconfig.json`).
- **Formatting**: Prettier (double quotes, semicolons, trailing commas, 100 cols).
- **Linting**: ESLint with `@typescript-eslint`.
- **Imports**: order `node:` builtins first, then third-party, then local
  (`./...`). Group with blank lines.
- **Comments / docs / commit messages**: English only.
- **Logging**: use the `log()` helper from `src/utils.ts` (writes to stderr —
   never pollute stdout, which carries the ACP protocol stream).

## Tests

- Unit tests live in `tests/` and run via Vitest.
- When fixing a bug, add a regression test that fails before the fix and passes
  after.
- When adding a feature, cover the core logic with unit tests. Handlers that
  depend on the live ZCode backend can be tested with a mocked `ZcodeBackend`
  (see `tests/backend.test.ts`).

## Commit Messages

Use the Conventional Commits format:

```
<type>: <short description in lowercase>

<optional body>
```

Where `<type>` is one of: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`,
`perf`. Keep the subject under 120 characters, imperative mood, no trailing
punctuation.

Examples:
- `feat: add session/fork extension handler`
- `fix: flatten todoGroups list so plan replay is not empty`
- `refactor: extract flattenTodos as a pure helper`

## Reporting Bugs

Open a [GitHub Issue](https://github.com/william0wang/zcode-acp/issues) with:
- ZCode CLI version (`zcode --version`)
- Editor + version (Zed, JetBrains, ...)
- Node.js version (`node --version`)
- Minimal reproduction steps
- Relevant stderr logs (the `[zcode-acp]` lines)

## License

By contributing, you agree that your contributions are licensed under the
Apache-2.0 license.
