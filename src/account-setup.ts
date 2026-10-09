/** Manual terminal setup; no interactive ACP authentication is advertised. */
import { emitKeypressEvents } from "node:readline";
import type { Key } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";

import { codingPlanCatalog, saveBridgeAccount } from "./config/bridge-accounts.js";
import type { CodingPlanFamily } from "./config/bridge-accounts.js";

/** Read a bounded ASCII key without echo, restoring terminal state on every exit. */
export function readHiddenApiKey(
  input: ReadStream,
  output: Pick<WriteStream, "write">,
): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== "function")
    return Promise.reject(new Error("Run account setup in an interactive terminal"));
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw;
    const wasPaused = input.isPaused();
    let value = "";
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      input.off("keypress", onKey);
      input.off("end", onEnd);
      input.off("error", onError);
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
      output.write("\n");
      if (error) reject(error);
      else resolve(value);
      value = "";
    };
    const onEnd = () => finish(new Error("Account setup cancelled"));
    const onError = () => finish(new Error("Cannot read terminal input"));
    const onKey = (text: string | undefined, key: Key) => {
      if (key.ctrl && (key.name === "c" || key.name === "d")) return onEnd();
      if (key.name === "return" || key.name === "enter") return finish();
      if (key.name === "backspace") {
        value = value.slice(0, -1);
        return;
      }
      if (key.ctrl || key.meta || !text) return;
      if (!/^[!-~]+$/u.test(text)) return finish(new Error("Invalid Coding Plan API key"));
      if (value.length + text.length > 4096)
        return finish(new Error("Coding Plan API key is too long"));
      value += text;
    };
    emitKeypressEvents(input);
    input.on("keypress", onKey);
    input.once("end", onEnd);
    input.once("error", onError);
    output.write("Coding Plan API key (hidden): ");
    input.setRawMode(true);
    input.resume();
  });
}

export async function runAccountSetup(
  args: string[],
  input = process.stdin,
  output = process.stderr,
): Promise<void> {
  if (args.length !== 2 || args[0] !== "--provider" || !["zai", "bigmodel"].includes(args[1]))
    throw new Error("Usage: zcode-acp setup --provider zai|bigmodel");
  const family = args[1] as CodingPlanFamily;
  if (!input.isTTY || !output.isTTY)
    throw new Error("Run account setup in an interactive terminal");
  codingPlanCatalog(family); // Validate installed public catalog before asking for a secret.
  output.write(
    "Use your individual Coding Plan API key. This saves a private bridge account; Desktop settings are preserved.\n",
  );
  const apiKey = await readHiddenApiKey(input, output);
  await saveBridgeAccount(family, apiKey);
  output.write(
    "Bridge account saved. Restart connected clients; the first model request verifies the key.\n",
  );
}
