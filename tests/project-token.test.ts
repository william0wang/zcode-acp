/**
 * project-token tests — the OAuth → project access token exchange that
 * answers `interaction/requestProviderRuntimeHeaders` on 3.15+ desktop
 * layouts, where the credential store holds an OAuth sign-in but no plan key.
 *
 * All fixtures are hermetic: a temp credential store and a fake network;
 * nothing touches the real ~/.zcode or the Coding Plan API.
 */

import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveCredentialSecret } from "../src/backend/credential-store.js";

const { storePath } = vi.hoisted(() => ({ storePath: { value: "" } }));

vi.mock("../src/utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils.js")>();
  return { ...actual, zcodeCredentialsPath: () => storePath.value };
});

import {
  clearProjectTokens,
  hasOAuthLogin,
  ProjectTokenError,
  projectTokenFingerprint,
  resolveOAuthProjectToken,
  setProjectTokenClientVersionForTest,
  setProjectTokenNetworkForTest,
} from "../src/config/project-token.js";

const ORIGIN = "https://api.z.ai";
const KEYS_URL = `${ORIGIN}/api/biz/v1/organization/org-personal/projects/proj-default/api_keys`;

function encryptCredential(plain: string): string {
  const key = createHash("sha256").update(resolveCredentialSecret()).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const cipherText = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}.${cipher
    .getAuthTag()
    .toString("base64url")}.${cipherText.toString("base64url")}`;
}

function writeStore(entries: Record<string, string>): void {
  writeFileSync(
    storePath.value,
    JSON.stringify(
      Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, encryptCredential(v)])),
    ),
  );
}

interface Call {
  url: string;
  method: string;
  authorization: string | null;
  body: unknown;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const CUSTOMER = {
  code: 200,
  data: {
    organizations: [
      {
        organizationId: "org-team",
        organizationName: "Team org",
        projects: [{ projectId: "proj-team", projectName: "Team", projectType: 2 }],
      },
      {
        organizationId: "org-personal",
        organizationName: "默认机构",
        projects: [
          { projectId: "proj-other", projectName: "Other", projectType: 1 },
          { projectId: "proj-default", projectName: "默认项目(42)", projectType: 1 },
        ],
      },
    ],
  },
};

let calls: Call[];
let keyList: unknown[];
let tokenResponses: Array<() => Response>;

function installNetwork(): void {
  setProjectTokenNetworkForTest(async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? "GET",
      authorization: headers.get("Authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (url === `${ORIGIN}/api/biz/customer/getCustomerInfo`) return json(200, CUSTOMER);
    if (url === KEYS_URL && (init?.method ?? "GET") === "GET") {
      return json(200, { code: 200, data: keyList });
    }
    if (url === `${KEYS_URL}/key-id-1/access_tokens`) {
      const next = tokenResponses.shift();
      if (!next) throw new Error("unexpected token request");
      return next();
    }
    throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
  });
}

function tokenOk(token: string, expiresInSec = 1800): () => Response {
  return () =>
    json(200, {
      code: 200,
      data: {
        accessToken: token,
        tokenType: "Bearer",
        expiresIn: expiresInSec,
        expiresAt: Math.floor(Date.now() / 1000) + expiresInSec,
      },
    });
}

beforeEach(() => {
  const root = mkdtempSync(path.join(tmpdir(), "project-token-"));
  mkdirSync(path.join(root, "v2"), { recursive: true });
  storePath.value = path.join(root, "v2", "credentials.json");
  writeStore({ "oauth:zai:access_token": "login-jwt" });
  calls = [];
  keyList = [
    { name: "litellm", apiKey: "key-id-0" },
    { name: "zcode-api-key", apiKey: "key-id-1" },
  ];
  tokenResponses = [];
  clearProjectTokens();
  setProjectTokenClientVersionForTest("3.17.1");
  installNetwork();
});

afterEach(() => {
  vi.useRealTimers();
  setProjectTokenClientVersionForTest(undefined);
});

describe("resolveOAuthProjectToken", () => {
  it("trades the OAuth sign-in for a project token on the personal default project", async () => {
    tokenResponses.push(tokenOk("project-token-1"));
    const material = await resolveOAuthProjectToken("zai");
    expect(material).toMatchObject({ token: "project-token-1", apiKeyId: "key-id-1" });
    expect(material.accountScope).toMatch(/^[a-f0-9]{64}$/u);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${ORIGIN}/api/biz/customer/getCustomerInfo`,
      `GET ${KEYS_URL}`,
      `POST ${KEYS_URL}/key-id-1/access_tokens`,
    ]);
    // Same header shapes as the desktop host: bare JWT for the customer lookup,
    // Bearer for the zai key list and the token issue.
    expect(calls.map((c) => c.authorization)).toEqual([
      "login-jwt",
      "Bearer login-jwt",
      "Bearer login-jwt",
    ]);
    expect(calls[2]!.body).toEqual({ clientType: "zcode", clientVersion: "3.17.1" });
  });

  it("drops the cached token when the backend rejects it under the same account scope", async () => {
    tokenResponses.push(tokenOk("project-token-1"), tokenOk("project-token-2"));
    const first = await resolveOAuthProjectToken("zai");
    const next = await resolveOAuthProjectToken("zai", {
      rejectedFingerprint: projectTokenFingerprint("project-token-1"),
      expectedAccountScope: first.accountScope,
    });
    expect(next.token).toBe("project-token-2");
    expect(next.accountScope).toBe(first.accountScope);
  });

  it("single-flights concurrent callers into one exchange", async () => {
    tokenResponses.push(tokenOk("project-token-1"));
    const [a, b] = await Promise.all([
      resolveOAuthProjectToken("zai"),
      resolveOAuthProjectToken("zai"),
    ]);
    expect(a.token).toBe("project-token-1");
    expect(b.token).toBe("project-token-1");
    expect(calls).toHaveLength(3);
  });

  it("keeps serving a still-valid token when a refresh fails transiently, with a backoff", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    tokenResponses.push(tokenOk("project-token-1", 600), () => json(503, {}));
    await resolveOAuthProjectToken("zai");
    vi.setSystemTime(Date.now() + 9 * 60_000);
    const next = await resolveOAuthProjectToken("zai");
    expect(next.token).toBe("project-token-1");
    // The next request inside the backoff window does not hit the API again.
    const again = await resolveOAuthProjectToken("zai");
    expect(again.token).toBe("project-token-1");
    expect(calls.filter((c) => c.url.endsWith("/access_tokens"))).toHaveLength(2);
  });

  it("never creates the zcode-api-key — a missing key is a fixed error", async () => {
    keyList = [{ name: "litellm", apiKey: "key-id-0" }];
    await expect(resolveOAuthProjectToken("zai")).rejects.toMatchObject({
      code: "project_token_key_missing",
    });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("refuses without an OAuth sign-in and never touches the network", async () => {
    writeStore({ zcodejwttoken: "unrelated" });
    expect(hasOAuthLogin("zai")).toBe(false);
    await expect(resolveOAuthProjectToken("zai")).rejects.toBeInstanceOf(ProjectTokenError);
    expect(calls).toHaveLength(0);
  });
});
