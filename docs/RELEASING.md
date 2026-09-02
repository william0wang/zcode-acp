# Releasing

Releases are fully automated: [release-please](https://github.com/googleapis/release-please)
turns Conventional Commits on `main` into a release PR, and merging that PR
tags the release, creates the GitHub Release and publishes to npm — no manual
version bumps, no npm token.

## How to cut a release

1. Land Conventional Commits on `main` (`feat:` → minor, `fix:`/`perf:` →
   patch, `feat!:` or `BREAKING CHANGE:` footer → major). Squash-merge PRs
   with a conventional title, or the change is invisible to release-please.
2. release-please opens or updates a `chore(main): release X.Y.Z` PR
   (version bump in `package.json` + `CHANGELOG.md` entry). It rewrites
   itself as more commits land.
3. Merge that PR. The `Release` workflow (`.github/workflows/release.yml`)
   tags `vX.Y.Z`, creates the GitHub Release, then builds, runs the test
   suite and publishes the package to npm. npmmirror follows on its own
   sync schedule.

There is no manual tagging step. `package.json` version and
`.release-please-manifest.json` are maintained by release-please — never edit
them by hand.

## Registry

The ACP Registry entry (`agentclientprotocol/registry`, id `zcode-acp`) pins
an explicit `package@version` for first inclusion, but its sync bot follows
new npm versions automatically afterwards — a release needs no registry PR.
