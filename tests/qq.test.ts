import assert from "node:assert/strict";
import test from "node:test";
import { createInitialConfig, type BotConfig } from "../src/config/schema.js";
import {
  buildMediaUploadBody,
  buildMediaMessageBody,
  buildTextMessageBody,
  type QQSendMediaInput,
  type QQSendTextInput,
  type QQUploadMediaInput,
} from "../src/qq/api.js";
import { QQSender } from "../src/qq/sender.js";
import {
  renderLatexForQQ,
  renderMarkdownForQQ,
  splitText,
} from "../src/qq/format.js";
import type { PreparedArtifact } from "../src/artifacts/file.js";
import type { QQInboundMessage } from "../src/qq/types.js";

test("QQ replies split at natural boundaries", () => {
  assert.deepEqual(splitText("one two three", 7), ["one two", "three"]);
  assert.deepEqual(splitText("short", 10), ["short"]);
  assert.deepEqual(splitText("123456😀", 7), ["123456", "😀"]);
  assert.deepEqual(splitText("😀x", 1), ["😀", "x"]);
});

test("Markdown is rendered as readable QQ plain text", () => {
  const markdown = [
    "# Result",
    "",
    "**Bold** and `code`; [docs](https://example.com).",
    "> quoted",
    "",
    "```ts",
    "const answer = 42;",
    "```",
    "",
    "| Name | Value |",
    "| --- | --- |",
    "| answer | **42** |",
  ].join("\n");

  assert.equal(
    renderMarkdownForQQ(markdown),
    [
      "[Result]",
      "",
      "Bold and [code]; docs (https://example.com).",
      "| quoted",
      "",
      "[Code: ts]",
      "  const answer = 42;",
      "",
      "Name | Value",
      "answer | 42",
    ].join("\n"),
  );
});

test("LaTeX formulas are rendered as readable QQ text", () => {
  const formula = String.raw`\[
match(x,g)=\text{x与猜测g在相同位置上数字相同的个数}
\]`;

  assert.equal(
    renderMarkdownForQQ(formula),
    [
      "[Formula]",
      "match(x, g) = x与猜测g在相同位置上数字相同的个数",
    ].join("\n"),
  );
  assert.equal(
    renderMarkdownForQQ(
      String.raw`Score \(x_i \geq \frac{1}{2}\); area is $r^2 \times \pi$.`,
    ),
    "Score xᵢ ≥ 1 / 2; area is r² × π.",
  );
  assert.equal(
    renderLatexForQQ(String.raw`\sqrt{x^2 + y^2} \approx 1`),
    "√(x² + y²) ≈ 1",
  );
  assert.equal(
    renderMarkdownForQQ("Tickets cost $5 and $10."),
    "Tickets cost $5 and $10.",
  );
  assert.equal(
    renderMarkdownForQQ("Use `\\[x^2\\]` literally."),
    "Use [\\[x^2\\]] literally.",
  );
});

test("agent output streams at complete Markdown blocks", async () => {
  const { sender, sent } = senderFixture({
    textChunkLimit: 200,
    streamMinChars: 100,
  });
  const reply = sender.createReply(inboundMessage());

  await reply.write(`# Overview\n\n${"a".repeat(110)}\n\n`);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /^\[Overview\]\n\na+$/);

  await reply.write("Final **answer**.");
  assert.equal(sent.length, 1);
  await reply.finish();

  assert.deepEqual(
    sent.map(({ sequence, text, markdown }) => ({ sequence, text, markdown })),
    [
      {
        sequence: 1,
        text: `[Overview]\n\n${"a".repeat(110)}`,
        markdown: false,
      },
      { sequence: 2, text: "Final answer.", markdown: false },
    ],
  );
});

test("streaming keeps a display LaTeX formula together", async () => {
  const { sender, sent } = senderFixture({
    textChunkLimit: 200,
    streamMinChars: 100,
  });
  const reply = sender.createReply(inboundMessage());

  await reply.write(`\\[\n${"x+".repeat(55)}\n`);
  assert.equal(sent.length, 0);

  await reply.write("\\]\n\n");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /^\[Formula\]\nx\+/);
  await reply.finish();
  assert.equal(sent.length, 1);
});

test("QQ passive replies are capped and visibly truncated", async () => {
  const { sender, sent } = senderFixture({
    textChunkLimit: 100,
    streamResponses: false,
  });

  await sender.reply(inboundMessage(), "x".repeat(650));

  assert.equal(sent.length, 5);
  assert.deepEqual(sent.map((message) => message.sequence), [1, 2, 3, 4, 5]);
  assert.match(sent[4]!.text, /Response truncated/);
  assert.ok(sent.every((message) => message.text.length <= 100));
});

test("native Markdown uses the QQ markdown message payload", () => {
  assert.deepEqual(
    buildTextMessageBody({
      chatType: "direct",
      targetId: "user",
      text: "# Title",
      replyToId: "message",
      sequence: 2,
      markdown: true,
    }),
    {
      msg_type: 2,
      markdown: { content: "# Title" },
      msg_id: "message",
      msg_seq: 2,
    },
  );
});

test("QQ artifact uploads and media payloads use rich-media messages", () => {
  for (const fileType of [1, 2, 3] as const) {
    assert.deepEqual(buildMediaUploadBody(Buffer.from([0, 1, 2]), fileType), {
      file_type: fileType,
      file_data: "AAEC",
      srv_send_msg: false,
    });
  }
  assert.deepEqual(
    buildMediaMessageBody({
      chatType: "group",
      targetId: "group",
      fileInfo: "uploaded-file",
      replyToId: "inbound",
      sequence: 3,
      caption: " Chart ",
    }),
    {
      content: "Chart",
      msg_type: 7,
      media: { file_info: "uploaded-file" },
      msg_id: "inbound",
      msg_seq: 3,
    },
  );
});

test("artifacts share reply sequencing and are deduplicated per turn", async () => {
  const { sender, sent, uploads, media, operations } = senderFixture({
    textChunkLimit: 200,
    streamMinChars: 100,
  });
  const reply = sender.createReply(inboundMessage());
  const video = artifact("video", "clip.mp4");
  const voice = artifact("voice", "voice.silk");

  await reply.write(`${"a".repeat(110)}\n\n`);
  assert.deepEqual(sent.map(({ sequence }) => sequence), [1]);

  assert.deepEqual(await reply.sendArtifact(video, "**Clip**"), {
    alreadySent: false,
  });
  assert.deepEqual(await reply.sendArtifact(video, "Duplicate"), {
    alreadySent: true,
  });
  assert.deepEqual(await reply.sendArtifact(voice), {
    alreadySent: false,
  });
  await assert.rejects(
    reply.sendArtifact(artifact("third", "third.png")),
    /At most 2 artifacts/,
  );

  await reply.write("Final **answer**.");
  await reply.finish();

  assert.equal(uploads.length, 2);
  assert.deepEqual(uploads.map(({ fileType }) => fileType), [2, 3]);
  assert.deepEqual(media.map(({ sequence }) => sequence), [2, 3]);
  assert.equal(media[0]?.caption, "Clip");
  assert.deepEqual(sent.map(({ sequence }) => sequence), [1, 4]);
  assert.deepEqual(
    operations,
    [
      "text:1",
      "upload:video",
      "media:2",
      "upload:voice",
      "media:3",
      "text:4",
    ],
  );
});

function senderFixture(output: Partial<BotConfig["output"]> = {}) {
  const config = createInitialConfig({
    appId: "app",
    clientSecretFile: "/unused",
    agentCommand: "agent",
  });
  config.output = { ...config.output, ...output };
  const sent: QQSendTextInput[] = [];
  const uploads: QQUploadMediaInput[] = [];
  const media: QQSendMediaInput[] = [];
  const operations: string[] = [];
  const sender = new QQSender(
    {
      sendText: async (input) => {
        sent.push(input);
        operations.push(`text:${input.sequence}`);
        return `message-${sent.length}`;
      },
      uploadMedia: async (input) => {
        uploads.push(input);
        operations.push(`upload:${input.data.toString()}`);
        return `file-${uploads.length}`;
      },
      sendMedia: async (input) => {
        media.push(input);
        operations.push(`media:${input.sequence}`);
        return `media-${media.length}`;
      },
    },
    () => config,
  );
  return { sender, sent, uploads, media, operations };
}

function artifact(digest: string, fileName: string): PreparedArtifact {
  if (fileName.endsWith(".mp4")) {
    return {
      data: Buffer.from(digest),
      digest,
      fileName,
      kind: "video",
      mimeType: "video/mp4",
    };
  }
  if (fileName.endsWith(".silk")) {
    return {
      data: Buffer.from(digest),
      digest,
      fileName,
      kind: "voice",
      mimeType: "audio/silk",
    };
  }
  return {
    data: Buffer.from(digest),
    digest,
    fileName,
    kind: "image",
    mimeType: fileName.endsWith(".jpg") ? "image/jpeg" : "image/png",
  };
}

function inboundMessage(): QQInboundMessage {
  return {
    accountId: "app",
    conversationId: "conversation",
    chatType: "direct",
    senderId: "user",
    targetId: "user",
    messageId: "inbound",
    timestamp: "2026-08-27T00:00:00Z",
    text: "hello",
    attachments: [],
  };
}
