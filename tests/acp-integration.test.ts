import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "../src/acp/session-manager.js";
import { SessionStateStore } from "../src/acp/state.js";
import { createInitialConfig } from "../src/config/schema.js";

test("per-conversation manager exchanges prompts with an ACP child process", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "qq-bot-acp-agent-"));
  const fixture = path.resolve("tests", "fixtures", "fake-agent.mjs");
  const config = createInitialConfig({
    appId: "unused",
    clientSecretFile: path.join(temp, "secret"),
    agentCommand: process.execPath,
    agentArgs: [fixture],
    agentCwd: process.cwd(),
  });
  const manager = new SessionManager(
    config,
    new SessionStateStore(path.join(temp, "sessions.json")),
    () => {},
  );
  manager.start();
  const replies: string[] = [];
  try {
    await manager.prompt(
      "qqbot:test:direct:user",
      [{ type: "text", text: "hello" }],
      { onText: async (text) => { replies.push(text); } },
    );
    assert.deepEqual(replies, ["echo:hello"]);

    const options = await manager.setSessionConfig(
      "qqbot:test:direct:user",
      "model",
      "large",
    );
    assert.equal(options[0]?.currentValue, "large");
  } finally {
    await manager.stop();
  }
});
