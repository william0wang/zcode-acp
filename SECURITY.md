# Security Policy

## Reporting a Vulnerability

This project bridges the ZCode CLI to ACP-compatible editors and handles ZCode
credentials (`~/.zcode/v2/config.json`). Security issues are taken seriously.

**Please do NOT open public GitHub issues for security vulnerabilities.**

Instead, report vulnerabilities privately:

1. Open a **private security advisory** via GitHub's
   [Report a vulnerability](https://github.com/william0wang/zcode-acp/security/advisories/new)
   feature, or
2. Email the maintainer directly (see the GitHub profile for contact info).

Please include:
- A description of the issue and its potential impact
- Steps to reproduce (proof of concept, logs, etc.)
- Affected versions / commit
- Any suggested fix or mitigation

You should receive an initial response within **72 hours**. If the issue is
confirmed, a fix and public advisory will be coordinated with you.

## Scope

In scope:
- Anything in this repository (the bridge server, its protocol handling, the
  process lifecycle / watchdog).
- Mishandling of ZCode credentials, tokens, or session data by the bridge.
- Crashes, hangs, or resource leaks triggered by malformed input.

Out of scope:
- Vulnerabilities in the upstream ZCode CLI itself — report those to
  [Zhipu Z.AI](https://z.ai).
- Vulnerabilities in editors (Zed, JetBrains) or the ACP specification —
  report those to the respective upstreams.
- Issues that require already having code execution on the user's machine.

## Credential Handling

The bridge reads ZCode credentials from `~/.zcode/v2/config.json` (created by
the ZCode app) and forwards them to the ZCode subprocess via environment
variables. Credentials are **never** written to logs, stdout, or disk by the
bridge. If you find a code path that leaks credentials, please report it as a
security issue (not a regular bug).
