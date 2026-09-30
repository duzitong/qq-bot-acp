import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "../src/acp/session-manager.js";
import { SessionStateStore } from "../src/acp/state.js";
import { ArtifactBroker } from "../src/artifacts/broker.js";
import { BotController } from "../src/bot/controller.js";
import { formatSessionConfig } from "../src/bot/commands.js";
import { resolveBotPaths } from "../src/config/paths.js";
import { createInitialConfig } from "../src/config/schema.js";
import { ConfigStore } from "../src/config/store.js";
import type { QQSendStreamInput, QQSendTextInput } from "../src/qq/api.js";
import { QQSender } from "../src/qq/sender.js";
import type { QQInboundMessage } from "../src/qq/types.js";

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
  config.access.admins = ["user"];
  const sent: QQSendTextInput[] = [];
  const streams: QQSendStreamInput[] = [];
  const sender = new QQSender({
    sendText: async (input) => {
      sent.push(input);
      return "command-reply";
    },
    sendStream: async (input) => {
      streams.push(input);
      return { id: "agent-reply" };
    },
    uploadMedia: async () => { throw new Error("Unexpected media upload"); },
    sendMedia: async () => { throw new Error("Unexpected media reply"); },
  }, () => config);
  const controller = new BotController(
    config,
    new ConfigStore(resolveBotPaths(undefined, temp)),
    manager,
    sender,
    () => {},
  );
  const message: QQInboundMessage = {
    accountId: "unused",
    conversationId: "qqbot:test:direct:user",
    chatType: "direct",
    senderId: "user",
    targetId: "user",
    messageId: "config-command",
    timestamp: "2026-08-27T00:00:00Z",
    text: "/sc",
    attachments: [],
  };
  const replies: string[] = [];
  let completed = false;
  try {
    await controller.handleMessage(message);
    assert.match(sent[0]!.text, /No active ACP session/);
    assert.equal((await manager.getSessionConfig(message.conversationId)).active, false);
    assert.equal(streams.length, 0);

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

    for (const text of ["/sc", "/session-config"]) {
      await controller.handleMessage({ ...message, text });
      assert.equal(
        sent.at(-1)!.text,
        formatSessionConfig(await manager.getSessionConfig(message.conversationId)),
      );
      assert.equal(sent.at(-1)!.replyToId, message.messageId);
      assert.equal(sent.at(-1)!.sequence, 1);
      assert.equal(sent.at(-1)!.markdown, true);
    }
    assert.equal(sent.length, 3);
    assert.equal(streams.length, 0);
    assert.equal(controller.getConfig().output.streamResponses, true);

    await controller.handleMessage({ ...message, messageId: "agent-prompt", text: "hello again" });
    assert.equal(sent.length, 3);
    assert.deepEqual(streams.map(({ state }) => state), [1, 10]);
    assert.ok(streams.every(({ replyToId }) => replyToId === "agent-prompt"));
    assert.match(streams.at(-1)!.text, /^echo:hello again/);
  } finally {
    await manager.stop();
    await artifacts.stop();
    await fs.rm(temp, { recursive: true, force: true });
  }
});
