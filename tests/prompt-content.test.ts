import { mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { convertPromptContent, PROMPT_LIMITS } from "../src/handlers/prompt-content.js";

const dirs: string[] = [];
async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "acp-content-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const blob = (mimeType: string, bytes: string, uri = "file:///nonexistent/resource") =>
  ({
    type: "resource",
    resource: { uri, mimeType, blob: Buffer.from(bytes).toString("base64") },
  }) as ContentBlock;

describe("embedded resource conversion", () => {
  it("forwards supplied PDF and image bytes in native order, without reading their URIs", async () => {
    const input = [
      blob("application/pdf", "%PDF-synthetic", "file:///missing/report.pdf"),
      blob("image/png", "synthetic-pixels", "file:///missing/vision.png"),
    ];
    const result = await convertPromptContent(input, await directory());
    expect(result.text).toBe("");
    expect(result.attachments).toEqual([
      {
        kind: "pdf",
        filename: "report.pdf",
        mimeType: "application/pdf",
        dataBase64: Buffer.from("%PDF-synthetic").toString("base64"),
        sizeBytes: 14,
      },
      {
        kind: "image",
        filename: "vision.png",
        mimeType: "image/png",
        dataBase64: Buffer.from("synthetic-pixels").toString("base64"),
        sizeBytes: 16,
      },
    ]);
  });
  it("preserves embedded text and existing local/remote links without fetching", async () => {
    const result = await convertPromptContent(
      [
        { type: "text", text: "  prefix  " },
        {
          type: "resource",
          resource: { uri: "memory://text", text: "TEXT736", mimeType: "text/plain" },
        },
        { type: "resource_link", name: "doc", uri: "file:///tmp/my%20doc.txt" },
        { type: "resource_link", name: "remote", uri: "https://example.invalid/reference" },
      ],
      await directory(),
    );
    expect(result.text).toBe(
      "prefix  \nTEXT736\n[related resource: doc](/tmp/my doc.txt)\n[related resource: remote](https://example.invalid/reference)",
    );
    expect(result.attachments).toEqual([]);
  });
  it("stages exact arbitrary binary bytes privately and retains them across conversions", async () => {
    const root = await directory(),
      storage = join(root, "storage");
    const result = await convertPromptContent(
      [blob("application/octet-stream", "\0binary736", "memory://attachment/../../data.bin")],
      storage,
    );
    const attachment = result.attachments[0];
    expect(attachment.kind).toBe("file");
    expect(attachment.localPath?.startsWith(storage + "/")).toBe(true);
    expect(await readFile(attachment.localPath!)).toEqual(Buffer.from("\0binary736"));
    if (process.platform !== "win32") {
      expect((await stat(storage)).mode & 0o777).toBe(0o700);
      expect((await stat(attachment.localPath!)).mode & 0o777).toBe(0o600);
    }
    await convertPromptContent([{ type: "text", text: "next prompt" }], storage);
    expect(await readFile(attachment.localPath!)).toEqual(Buffer.from("\0binary736"));
  });
  it("removes staged files if a later block fails validation", async () => {
    const storage = await directory();
    await expect(
      convertPromptContent(
        [
          blob("text/csv", "code\nCSV736"),
          {
            type: "resource",
            resource: { uri: "memory://bad", mimeType: "application/pdf", blob: "!!!!" },
          },
        ],
        storage,
      ),
    ).rejects.toMatchObject({ code: -32602 });
    expect(await readdir(storage)).toEqual([]);
  });
  it("rejects a symlink staging directory instead of writing to its target", async () => {
    const root = await directory(),
      target = await directory();
    await symlink(target, join(root, "link"));
    await expect(
      convertPromptContent([blob("application/octet-stream", "bytes")], join(root, "link")),
    ).rejects.toMatchObject({ code: -32602 });
    expect(await readdir(target)).toEqual([]);
  });
  it("uses image bytes rather than a conflicting or nonexistent image URI", async () => {
    const result = await convertPromptContent(
      [
        {
          type: "image",
          uri: "file:///missing/image.png",
          mimeType: "image/png",
          data: "AQIDBA==",
        },
      ],
      await directory(),
    );
    expect(result.attachments[0]).toMatchObject({
      kind: "image",
      dataBase64: "AQIDBA==",
      sizeBytes: 4,
    });
    expect(result.attachments[0].localPath).toBeUndefined();
  });
  it("supports empty embedded text as context and rejects empty binary/ambiguous resources", async () => {
    expect(
      (
        await convertPromptContent(
          [{ type: "resource", resource: { uri: "memory://empty", text: "" } }],
          await directory(),
        )
      ).text,
    ).toBe("Empty resource: memory://empty");
    for (const resource of [
      { uri: "memory://empty", blob: "" },
      { uri: "memory://both", text: "text", blob: "AQID" },
    ])
      await expect(
        convertPromptContent([{ type: "resource", resource } as ContentBlock], await directory()),
      ).rejects.toMatchObject({ code: -32602 });
  });
  it("rejects malformed MIME/base64, unsupported audio and nonabsolute resource URIs", async () => {
    for (const input of [
      [{ type: "resource", resource: { uri: "relative", text: "text" } }],
      [{ type: "resource", resource: { uri: "memory://x", mimeType: "not a type", blob: "AQID" } }],
      [{ type: "resource", resource: { uri: "memory://x", blob: "AB==" } }],
      [{ type: "audio", mimeType: "audio/wav", data: "AQID" }],
    ])
      await expect(
        convertPromptContent(input as ContentBlock[], await directory()),
      ).rejects.toMatchObject({ code: -32602 });
  });
  it("enforces count, per-image and total bounds before native send", async () => {
    await expect(
      convertPromptContent(
        Array.from({ length: PROMPT_LIMITS.blocks + 1 }, () => ({ type: "text", text: "x" })),
        await directory(),
      ),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      convertPromptContent(
        [
          {
            type: "image",
            mimeType: "image/png",
            data: Buffer.alloc(PROMPT_LIMITS.image + 1).toString("base64"),
          },
        ],
        await directory(),
      ),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      convertPromptContent(
        [{ type: "text", text: "x".repeat(PROMPT_LIMITS.total + 1) }],
        await directory(),
      ),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(convertPromptContent([], await directory())).rejects.toMatchObject({
      code: -32602,
    });
  });
});
