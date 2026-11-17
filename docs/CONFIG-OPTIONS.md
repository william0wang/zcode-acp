# Config Options & Provider Metadata (ACP client guide)

How an ACP client renders the bridge's session options and builds a
provider/model picker **without duplicating bridge internals**. Covers the
`configOptions` array (`session/new`, `session/load`, `session/resume`,
`config_option_update`), the model-value encoding, and the `_meta.zcode`
provider metadata (issue #400).

## The three options

| id        | category        | type     | addresses (set_config_option)                       |
| --------- | --------------- | -------- | --------------------------------------------------- |
| `model`   | `model`         | `select` | provider+model pair                                 |
| `mode`    | `mode`          | `select` | ZCode mode (`plan`/`build`/`edit`/`guarded`/`yolo`) |
| `thought` | `thought_level` | `select` | reasoning effort of the current model               |

All three are optional per ACP — the `model` option is omitted when the
session has no resolvable provider identity.

## Model option values

**Canonical form (emitted): `providerId\modelId`** — always provider-qualified,
builtins included. The `\` separator is unambiguous: provider ids (`builtin:`
slugs, custom UUIDs) and model ids (`/`-separated) never contain it. When two
providers ship the same model id, labels qualify as `Provider › model`.

Two provider-id dialects appear in **values**:

- **config dialect** — `builtin:bigmodel-coding-plan`, custom UUIDs. Used by
  the pre-materialization (`session/new`) menu.
- **registry dialect** — `account:bigmodel-individual-coding-plan`. Used by a
  materialized session's snapshot, because same-named models of colliding
  legacy plans only stay distinct in that spelling. Values keep the dialect
  they were built from; both dialects are accepted inbound.

**Accepted inbound spellings** (`session/set_config_option` on `model`):

| spelling                                   | meaning                                                               |
| ------------------------------------------ | --------------------------------------------------------------------- |
| `providerId\modelId`                       | canonical (recommended for round-tripping)                            |
| `modelId` (no `\`)                         | legacy bare id — resolved to the first enabled builtin provider       |
| `custom:<urlencoded-providerId>:<modelId>` | the 3.12+ agent-definition spelling (provider colons percent-encoded) |

The backslash form stays canonical for compatibility — every deployed client
round-trips it, and switching now would break them. Encode/decode it as an
opaque string; do not split on `\` in config languages where it is an escape
character (use the `custom:` form when constructing values yourself).

## Provider metadata: `_meta.zcode`

Two surfaces carry the same payload (issue #400):

1. **`session/new` response `_meta.zcode`** — the boot snapshot.
2. **The `model` configOption's `_meta.zcode`** — the refresh vehicle. It is
   re-attached on **every** `config_option_update` (model/mode/thought
   switches, credential-change rebuilds), so the provider list stays live for
   the session's whole lifetime. Clients that want updates should read it from
   the option, not cache the boot snapshot.

```json
{
  "providers": [
    {
      "id": "builtin:bigmodel-coding-plan",
      "name": "BigModel",
      "selectable": true,
      "defaultModel": "GLM-5.3"
    },
    {
      "id": "builtin:bigmodel-start-plan",
      "name": "BigModel Start Plan",
      "selectable": false,
      "unselectableReason": "keyless-builtin"
    }
  ],
  "currentProviderId": "builtin:bigmodel-coding-plan"
}
```

- `id` is always the **config dialect** (`builtin:…` / custom UUID), matching
  the other config-sourced fields. `currentProviderId` folds registry
  `account:` refs onto it, so it always matches an entry in `providers`.
- `selectable` mirrors what the model dropdown offers — derived from the same
  model list the bridge itself advertises, so the two can never disagree.
  `defaultModel` is the model a session started on that provider runs (the
  first entry of its dropdown group).
- `unselectableReason` (only when `selectable` is false) lets a client render
  an actionable row instead of a silent gap:

| reason              | meaning                                                  | client hint                                       |
| ------------------- | -------------------------------------------------------- | ------------------------------------------------- |
| `keyless-builtin`   | builtin provider enabled but no credential stored        | "link account / enter API key in the desktop app" |
| `disabled`          | provider explicitly disabled (or no entry)               | —                                                 |
| `non-local-keyless` | custom remote endpoint with no API key and keys required | "add an API key or use a localhost endpoint"      |

Providers entitled only through the account ladder (OAuth sign-in, manual
coding-plan keys) appear as `selectable: true` entries with the models that
entitlement grants.

## Provider switching and pinning

Switching provider within a session is a **model switch**: send
`session/set_config_option` with a `providerId\modelId` value from any
selectable provider — no separate provider control exists on the wire.

Pinning the credential provider is **process-level** (`ZCODE_PROVIDER` env at
bridge start): the backend subprocess is spawned once per bridge process with
the resolved provider's credentials injected, so a session-scoped pin would
imply a keyed child-process pool that does not exist today. When `ZCODE_PROVIDER`
is set, both the model dropdown and `_meta.zcode.providers` filter to that
provider. Clients should treat provider selection as "pick a model" unless
they also control the bridge's environment.
