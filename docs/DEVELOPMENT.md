# Development Guide

## Prerequisites

### Requirements

- Node.js >= 22 (requires `node:sqlite` support)
- pnpm (package manager)
- ZCode CLI >= 0.14.8

### Install dependencies

```bash
cd zcode-acp-server
pnpm install
```

## Local Development

### Build

```bash
pnpm build        # tsc -> dist/
pnpm dev          # tsc --watch (hot reload)
```

### Test

```bash
pnpm test         # run all tests
pnpm test:watch   # watch mode
```

### Format

```bash
pnpm format       # prettier --write src
```

## Manual Testing

### Method 1: Start directly

```bash
pnpm build
node dist/index.js
```

Then manually send an ACP JSON-RPC request:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": 1 } }
```

### Method 2: Connect via Zed

Add the following to `~/.config/zed/settings.json` (see the README for the
full `ZCODE_BIN` per-platform paths):

```json
{
  "agent_servers": {
    "ZCode": {
      "type": "custom",
      "command": "node",
      "args": ["/absolute/path/to/zcode-acp-server/dist/index.js"],
      "env": {
        "ZCODE_BIN": "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"
      }
    }
  }
}
```

Restart Zed and pick **ZCode** from the agent dropdown.

### Method 3: Mock backend testing

See `tests/backend.test.ts` for how to mock `ZcodeBackend`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { ZcodeBackend } from "../src/backend/client.js";

describe("backend", () => {
  it("should handle request/response", async () => {
    const backend = new ZcodeBackend(["node", "mock-zcode.js"], { ...process.env });
    // test logic
  });
});
```

## Debugging Tips

### Enable verbose logging

The code uses a `log()` function (written to stderr); you can see output like
this in the terminal:

```
[zcode-acp] backend: started zcode app-server (pid=12345)
[zcode-acp]   [event] turn.started
[zcode-acp]   [event] turn.completed (resultType=success)
```

### Check the ZCode backend version

```bash
zcode --version
# must be >= 0.14.8
```

### Check the ZCode configuration

```bash
cat ~/.zcode/v2/config.json
# confirm a provider is enabled and has models
```

The bridge reads the GLM API key from this file and forwards it to the ZCode
subprocess — no editor-side API key or environment variable is required. If
`config.json` is missing or no provider is enabled, install and log into the
ZCode desktop app so it writes a valid file.

### Test session/subscribe

```bash
# start the zcode app-server
cd /path/to/project
zcode app-server --stdio

# manually send a request
{ "id": 1, "method": "session/create", "params": { "workspace": { "workspacePath": ".", "workspaceKey": "." }, "mode": "yolo" } }
```

## Adding a New Session Extension Method

Using `session/customAction` as an example:

### 1. Add the handler in `src/handlers/extensions.ts`

```typescript
export async function customAction(
  server: ZcodeAcpServer,
  params: ExtensionParams,
): Promise<Result> {
  const zcodeSid = resolveSidOrThrow(server, params);
  const resp = await server
    .ensureBackend()
    .request(server.nextId(), "session/customAction", { sessionId: zcodeSid, ...params }, 15000);
  if (resp.error) throw new Error(`customAction failed: ${resp.error.message}`);
  log("session/customAction -> ok");
  return (resp.result ?? {}) as Result;
}
```

### 2. Register it in `src/index.ts`

```typescript
import { customAction } from "./handlers/extensions.js";

.onRequest("session/customAction", extParams, (ctx) =>
  customAction(server, ctx.params),
)
```

### 3. Add a test

Add a test in `tests/extensions.test.ts` (create it if it does not exist):

```typescript
import { describe, it, expect } from "vitest";
import { customAction } from "../src/handlers/extensions.js";

describe("customAction", () => {
  it("should forward to zcode backend", async () => {
    // mock server and backend
    // test the handler logic
  });
});
```

## Contributing

### PR checklist

- [ ] Code passes `pnpm build` (no TypeScript errors)
- [ ] All tests pass `pnpm test`
- [ ] Code is formatted `pnpm format`
- [ ] New methods have corresponding tests
- [ ] Documentation is updated (if needed)

### Code style

- Use TypeScript strict mode
- Files use the `.js` extension (Node.js ESM requirement)
- Logging uses the `log()` function (writes to stderr to avoid polluting the stdout protocol stream)
- Error handling: return `{ error }` instead of throwing (at the backend request layer)
