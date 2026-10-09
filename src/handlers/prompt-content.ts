/**
 * Adapted from t3-zcode-bridge/content.mjs (v0.3.0).
 * Copyright (c) 2026 Sarthak
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";

export const PROMPT_LIMITS = { blocks: 100, image: 10 * 1024 * 1024, total: 50 * 1024 * 1024 };
const imageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/svg+xml",
]);
export interface NativePromptAttachment {
  kind: "image" | "pdf" | "file";
  filename: string;
  mimeType: string;
  sizeBytes: number;
  dataBase64?: string;
  localPath?: string;
}
function invalid(message: string): never {
  throw new RequestError(-32602, message);
}
function mime(value = "application/octet-stream"): string {
  const type = value.split(";", 1)[0].trim().toLowerCase();
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type)) invalid("Invalid attachment MIME type");
  return type;
}
function decode(data: string, limit: number): Buffer {
  if (
    typeof data !== "string" ||
    data.length > Math.ceil(limit / 3) * 4 ||
    data.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(data)
  )
    invalid("Invalid or oversized base64 attachment");
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) invalid("Invalid base64 attachment");
  if (!bytes.length || bytes.length > limit) invalid("Empty or oversized binary attachment");
  return bytes;
}
function filename(uri: string | undefined | null, fallback: string): string {
  try {
    return basename(decodeURIComponent(new URL(uri || "").pathname)) || fallback;
  } catch {
    return fallback;
  }
}

/** Supplied embedded bytes are authoritative; URIs are names, not download instructions.
 * Successful staged files persist because native tools and resumed sessions may read them later.
 */
export async function convertPromptContent(
  blocks: ContentBlock[],
  stagingDir: string,
): Promise<{ text: string; attachments: NativePromptAttachment[] }> {
  if (!Array.isArray(blocks) || blocks.length > PROMPT_LIMITS.blocks)
    invalid("Too many prompt blocks");
  const text: string[] = [],
    attachments: NativePromptAttachment[] = [],
    created: string[] = [];
  let total = 0;
  const charge = (bytes: number, type = "text/plain"): void => {
    if (type.startsWith("image/") && bytes > PROMPT_LIMITS.image)
      invalid("Images must be at most 10 MiB each");
    total += bytes;
    if (total > PROMPT_LIMITS.total) invalid("Prompt content exceeds 50 MiB");
  };
  const binary = async (data: string, type: string, name: string): Promise<void> => {
    const bytes = decode(
      data,
      type.startsWith("image/") ? PROMPT_LIMITS.image : PROMPT_LIMITS.total,
    );
    charge(bytes.length, type);
    if (imageTypes.has(type) || type === "application/pdf") {
      attachments.push({
        kind: type === "application/pdf" ? "pdf" : "image",
        filename: name,
        mimeType: type,
        dataBase64: data,
        sizeBytes: bytes.length,
      });
    } else {
      await mkdir(stagingDir, { recursive: true, mode: 0o700 });
      const directory = await lstat(stagingDir);
      if (!directory.isDirectory() || directory.isSymbolicLink())
        invalid("Invalid attachment staging directory");
      await chmod(stagingDir, 0o700);
      const localPath = join(
        stagingDir,
        `${randomUUID()}-${
          basename(name)
            .replace(/[^a-zA-Z0-9._-]/g, "_")
            .slice(0, 120) || "attachment"
        }`,
      );
      await writeFile(localPath, bytes, { flag: "wx", mode: 0o600 });
      created.push(localPath);
      attachments.push({
        kind: "file",
        filename: name,
        mimeType: type,
        localPath,
        sizeBytes: bytes.length,
      });
    }
  };
  try {
    for (const block of blocks) {
      if (block.type === "text") {
        charge(Buffer.byteLength(block.text));
        text.push(block.text);
      } else if (block.type === "image") {
        const type = mime(block.mimeType);
        if (!type.startsWith("image/")) invalid("Image block requires an image MIME type");
        if (!imageTypes.has(type)) invalid("Unsupported inline image format");
        await binary(
          block.data,
          type,
          filename(block.uri, `image-${attachments.length + 1}.${type.split("/")[1]}`),
        );
      } else if (block.type === "resource") {
        const r = block.resource;
        try {
          new URL(r.uri);
        } catch {
          invalid("Embedded resource URI must be absolute");
        }
        const type = mime(r.mimeType || ("text" in r ? "text/plain" : undefined));
        if ("text" in r) {
          if ("blob" in r) invalid("Resource must contain text or blob, not both");
          charge(Buffer.byteLength(r.text), type);
          text.push(`[embedded resource: ${r.uri}]\n${r.text}`);
        } else await binary(r.blob, type, filename(r.uri, "resource"));
      } else if (block.type === "resource_link") {
        let location = block.uri;
        if (location.startsWith("file:")) {
          try {
            location = fileURLToPath(location);
          } catch {
            invalid("Invalid local file URI");
          }
        }
        const reference = `[related resource: ${block.name || location}](${location})`;
        charge(Buffer.byteLength(reference));
        text.push(reference);
      } else invalid("Unsupported prompt content type; audio transcription is not implemented");
    }
    let content = text.join("\n").trim();
    // Attached context must not become a native slash command merely because
    // its text starts with a command name. All-text command prompts are unchanged.
    if (blocks.some((block) => block.type !== "text") && content.startsWith("/")) {
      content = `[attached context]\n${content}`;
    }
    if (!content && !attachments.length) invalid("Prompt requires text or attachments");
    return { text: content, attachments };
  } catch (error) {
    await Promise.allSettled(created.map((p) => unlink(p)));
    throw error;
  }
}
