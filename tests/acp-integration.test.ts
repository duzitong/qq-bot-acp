import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "../src/acp/session-manager.js";
import { SessionStateStore } from "../src/acp/state.js";
import { ArtifactBroker } from "../src/artifacts/broker.js";
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
  const artifacts = new ArtifactBroker(() => {});
  await artifacts.start();
  const manager = new SessionManager(
    config,
    new SessionStateStore(path.join(temp, "sessions.json")),
    artifacts,
    () => {},
  );
  manager.start();
  const replies: string[] = [];
  let completed = false;
  try {
    await manager.prompt(
      "qqbot:test:direct:user",
      [{ type: "text", text: "hello" }],
      {
        onText: async (text) => { replies.push(text); },
        onComplete: async () => { completed = true; },
      },
    );
    assert.deepEqual(replies, ["echo:", "hello"]);
    assert.equal(completed, true);

    const firstTurn: string[] = [];
    const secondTurn: string[] = [];
    await Promise.all([
      manager.prompt(
        "qqbot:test:direct:user",
        [{ type: "text", text: "first" }],
        { onText: async (text) => { firstTurn.push(text); } },
      ),
      manager.prompt(
        "qqbot:test:direct:user",
        [{ type: "text", text: "second" }],
        { onText: async (text) => { secondTurn.push(text); } },
      ),
    ]);
    assert.deepEqual(firstTurn, ["echo:", "first"]);
    assert.deepEqual(secondTurn, ["echo:", "second"]);

    const options = await manager.setSessionConfig(
      "qqbot:test:direct:user",
      "model",
      "large",
    );
    assert.equal(options[0]?.currentValue, "large");
  } finally {
    await manager.stop();
    await artifacts.stop();
    await fs.rm(temp, { recursive: true, force: true });
  }
});
