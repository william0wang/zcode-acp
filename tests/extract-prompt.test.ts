/**
 * Regression tests for extractPromptText (prompt block flattening).
 *
 * History: the resource_link branch accessed `block.resource_link.name` /
 * `.uri`, but the ACP schema defines ResourceLink with `name` and `uri` FLAT
 * on the block (`{type:"resource_link", name, uri}`) — there is no nested
 * `resource_link` key. The wrong access meant every dragged-file attachment
 * was silently dropped from the prompt sent to zcode. These tests lock the
 * correct field access and the file:// → absolute-path rewrite so a model
 * treats dragged files as filesystem locations rather than opaque hyperlinks.
 */

import { describe, expect, it } from "vitest";

import { extractAttachments, extractPromptText } from "../src/handlers/session.js";

describe("extractPromptText", () => {
  it("concatenates multiple text blocks with newlines", () => {
    const out = extractPromptText([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
    expect(out).toBe("first\nsecond");
  });

  it("only trims the outermost whitespace, not per-block", () => {
    // Matches the original join("\n").trim() behaviour — internal block
    // whitespace survives. Locks the behaviour so a future "trim each block"
    // change is a deliberate decision, not an accident.
    const out = extractPromptText([
      { type: "text", text: "  hello  " },
      { type: "text", text: "  world  " },
    ]);
    expect(out).toBe("hello  \n  world");
  });

  it("returns empty string for no blocks / empty blocks", () => {
    expect(extractPromptText(undefined)).toBe("");
    expect(extractPromptText([])).toBe("");
  });

  describe("resource_link (dragged file)", () => {
    it("emits a markdown link with name + absolute path for file:// URIs", () => {
      const out = extractPromptText([
        {
          type: "resource_link",
          name: "AGENTS.md",
          uri: "file:///Users/william/Develop/tools/zcode-acp-server/.zcode/AGENTS.md",
        },
      ]);
      // file:// is rewritten to the absolute path so the model treats it as a
      // filesystem location, not an opaque hyperlink.
      expect(out).toBe(
        "[related resource: AGENTS.md]" +
          "(/Users/william/Develop/tools/zcode-acp-server/.zcode/AGENTS.md)",
      );
    });

    it("falls back to the uri when name is missing", () => {
      const out = extractPromptText([
        {
          type: "resource_link",
          name: "",
          uri: "file:///tmp/x.txt",
        } as never,
      ]);
      // Per the ACP schema `name` is required, but defensively fall back to
      // the decoded path so a non-compliant client still produces usable text.
      expect(out).toBe("[related resource: /tmp/x.txt](/tmp/x.txt)");
    });

    it("decodes percent-encoded bytes in file:// URIs", () => {
      const out = extractPromptText([
        {
          type: "resource_link",
          name: "my file",
          uri: "file:///Users/some%20one/file%20name.txt",
        },
      ]);
      expect(out).toBe("[related resource: my file](/Users/some one/file name.txt)");
    });

    it("keeps non-file:// URIs as-is (http, etc.)", () => {
      const out = extractPromptText([
        {
          type: "resource_link",
          name: "docs",
          uri: "https://example.com/docs",
        },
      ]);
      expect(out).toBe("[related resource: docs](https://example.com/docs)");
    });

    it("regression: the resource_link branch is actually entered", () => {
      // The bug: the old code accessed `block.resource_link.uri`, which was
      // always undefined because the ACP schema puts `uri` flat on the block.
      // With the fix, the link MUST appear in the output (not be silently
      // dropped).
      const out = extractPromptText([
        { type: "resource_link", name: "f", uri: "file:///x" },
        { type: "text", text: "describe this" },
      ]);
      expect(out).toContain("/x");
      expect(out).toContain("describe this");
    });
  });

  describe("resource (embedded)", () => {
    it("inlines embedded text resource contents", () => {
      const out = extractPromptText([
        {
          type: "resource",
          resource: { uri: "file:///x", text: "embedded body" },
        },
      ] as never);
      expect(out).toBe("embedded body");
    });

    it("skips embedded resources without a text payload", () => {
      const out = extractPromptText([
        {
          type: "resource",
          resource: { uri: "file:///x", blob: "aGVsbG8=" },
        },
      ] as never);
      expect(out).toBe("");
    });
  });
});

describe("extractAttachments", () => {
  it("returns [] for no blocks / non-image blocks", () => {
    expect(extractAttachments(undefined)).toEqual([]);
    expect(extractAttachments([])).toEqual([]);
    expect(
      extractAttachments([
        { type: "text", text: "hello" },
        { type: "resource_link", name: "f", uri: "file:///x" },
      ]),
    ).toEqual([]);
  });

  it("converts a base64 image block to a dataBase64 attachment", () => {
    const out = extractAttachments([
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" } as never,
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("image");
    expect(out[0].mimeType).toBe("image/png");
    expect(out[0].dataBase64).toBe("aGVsbG8=");
    // sizeBytes estimated from base64 length (8 chars → 6 bytes)
    expect(out[0].sizeBytes).toBe(6);
    expect(out[0].localPath).toBeUndefined();
    // synthesized filename from mimeType
    expect(out[0].filename).toBe("image-1.png");
  });

  it("prefers a file:// uri → localPath over the base64 payload", () => {
    const out = extractAttachments([
      {
        type: "image",
        data: "aGVsbG8=",
        mimeType: "image/jpeg",
        uri: "file:///Users/william/pics/cat.jpeg",
      } as never,
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].localPath).toBe("/Users/william/pics/cat.jpeg");
    expect(out[0].dataBase64).toBeUndefined();
    // filename derived from the uri basename
    expect(out[0].filename).toBe("cat.jpeg");
  });

  it("decodes percent-encoded file:// uris for localPath", () => {
    const out = extractAttachments([
      {
        type: "image",
        mimeType: "image/png",
        uri: "file:///Users/some%20one/my%20pic.png",
      } as never,
    ]);
    expect(out[0].localPath).toBe("/Users/some one/my pic.png");
    expect(out[0].filename).toBe("my pic.png");
  });

  it("synthesizes filename from uri basename when mimeType is unknown", () => {
    const out = extractAttachments([
      {
        type: "image",
        data: "AAAA",
        mimeType: "image/x-weird",
        uri: "https://example.com/foo.png",
      } as never,
    ]);
    // http uri is not a localPath, so falls to dataBase64; filename from uri basename
    expect(out[0].dataBase64).toBe("AAAA");
    expect(out[0].localPath).toBeUndefined();
    expect(out[0].filename).toBe("foo.png");
  });

  it("keeps image order and indexes filenames for multiple base64 images", () => {
    const out = extractAttachments([
      { type: "image", data: "AAAA", mimeType: "image/png" } as never,
      { type: "text", text: "and another" },
      { type: "image", data: "BBBB", mimeType: "image/jpeg" } as never,
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].filename).toBe("image-1.png");
    expect(out[1].filename).toBe("image-2.jpg");
  });

  it("drops an image block with neither a usable uri nor data", () => {
    const out = extractAttachments([{ type: "image", mimeType: "image/png" } as never]);
    expect(out).toEqual([]);
  });

  it("image blocks do not leak into extractPromptText text", () => {
    // Images are routed via attachments, never inlined into the prompt text.
    const blocks = [
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      { type: "text", text: "describe this" },
    ];
    expect(extractPromptText(blocks as never)).toBe("describe this");
    expect(extractAttachments(blocks as never)).toHaveLength(1);
  });
});
