# Domain Docs

How engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root (if it exists) — it points to one `CONTEXT.md` per context. Read each file relevant to the current topic.
- **`docs/adr/`** — read ADRs related to the area you are about to work on. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If these files don't exist, **continue silently**. Don't flag the absence; don't proactively suggest creating them. The producer skill (`/grill-with-docs`) will lazily create them when terms or decisions are actually resolved.

## File structure

Single-context repo (most repos):

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

Multi-context repo (root has `CONTEXT-MAP.md`):

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← context-specific decisions
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## Use the glossary's vocabulary

When your output names a domain concept (issue title, refactor proposal, hypothesis, test name), use the term defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider), or there's a genuine gap (note it for `/grill-with-docs`).

## Flag ADR conflicts

If your output contradicts an existing ADR, call it out explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
