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
  renderNativeMarkdownForQQ,
  splitMarkdown,
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

test("channel-compatible plain text avoids decorative Markdown simulation", () => {
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
      "Result",
      "",
      "Bold and code; docs (https://example.com).",
      "> quoted",
      "",
      "Code (ts):",
      "const answer = 42;",
      "",
      "Name | Value",
      "answer | 42",
    ].join("\n"),
  );
});

test("plain text keeps code copy-safe without brackets or Unicode frames", () => {
  assert.equal(
    renderMarkdownForQQ(
      "Run `bin/tool --flag=[x]`, then keep ``a ` b`` unchanged.",
    ),
    "Run bin/tool --flag=[x], then keep a ` b unchanged.",
  );

  assert.equal(
    renderMarkdownForQQ(
      [
        "```bash",
        "printf '%s\\n' \"a[b]\"",
        "  indented();",
        "",
        "```not-a-closing-fence",
        "```",
        "",
        "~~~",
        "plain <tag> & punctuation!",
        "~~~",
        "",
        "```text",
        "```",
      ].join("\n"),
    ),
    [
      "Code (bash):",
      "printf '%s\\n' \"a[b]\"",
      "  indented();",
      "",
      "```not-a-closing-fence",
      "",
      "Code:",
      "plain <tag> & punctuation!",
      "",
      "Code (text):",
    ].join("\n"),
  );
});

test("LaTeX remains readable in native and plain QQ output", () => {
  const formula = String.raw`\[
match(x,g)=\text{x与猜测g在相同位置上数字相同的个数}
\]`;

  assert.equal(
    renderMarkdownForQQ(formula),
    [
      "Formula:",
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
    "Use \\[x^2\\] literally.",
  );
  assert.equal(
    renderMarkdownForQQ(["```tex", "$$x^2$$", "```"].join("\n")),
    ["Code (tex):", "$$x^2$$"].join("\n"),
  );
  assert.equal(
    renderNativeMarkdownForQQ(
      [
        "# Score",
        "",
        String.raw`Value \(x_i \geq \frac{1}{2}\).`,
        "",
        formula,
        "",
        "```tex",
        "$$x^2$$",
        "```",
      ].join("\n"),
    ),
    [
      "# Score",
      "",
      "Value xᵢ ≥ 1 / 2.",
      "",
      "match(x, g) = x与猜测g在相同位置上数字相同的个数",
      "",
      "```tex",
      "$$x^2$$",
      "```",
    ].join("\n"),
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
  assert.match(sent[0]!.text, /^# Overview\n\na+$/);

  await reply.write("Final **answer**.");
  assert.equal(sent.length, 1);
  await reply.finish();

  assert.deepEqual(
    sent.map(({ sequence, text, markdown }) => ({ sequence, text, markdown })),
    [
      {
        sequence: 1,
        text: `# Overview\n\n${"a".repeat(110)}`,
        markdown: true,
      },
      { sequence: 2, text: "Final **answer**.", markdown: true },
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
  assert.match(sent[0]!.text, /^x\+/);
  assert.equal(sent[0]!.markdown, true);
  await reply.finish();
  assert.equal(sent.length, 1);
});

test("streaming keeps a fenced code block together", async () => {
  const { sender, sent } = senderFixture({
    textChunkLimit: 240,
    streamMinChars: 100,
  });
  const reply = sender.createReply(inboundMessage());

  await reply.write(`\`\`\`bash\nprintf '%s' "${"x".repeat(110)}"\n`);
  assert.equal(sent.length, 0);

  await reply.write("```\n\n");
  assert.equal(sent.length, 1);
  assert.equal(
    sent[0]!.text,
    [
      "```bash",
      `printf '%s' "${"x".repeat(110)}"`,
      "```",
    ].join("\n"),
  );
  assert.equal(sent[0]!.markdown, true);
  await reply.finish();
  assert.equal(sent.length, 1);
});

test("long native Markdown splits into valid fenced code and list chunks", () => {
  const codeLines = Array.from(
    { length: 8 },
    (_, index) => `const value${index} = "${"x".repeat(25)}";`,
  );
  const codeChunks = splitMarkdown(
    ["```ts", ...codeLines, "```"].join("\n"),
    100,
  );
  assert.ok(codeChunks.length > 1);
  assert.ok(codeChunks.every((chunk) => chunk.length <= 100));
  assert.ok(codeChunks.every((chunk) => /^```ts\n[\s\S]*\n```$/.test(chunk)));
  assert.deepEqual(
    codeChunks.flatMap((chunk) => chunk.split("\n").slice(1, -1)),
    codeLines,
  );

  const list = [
    "# Tasks",
    "",
    ...Array.from(
      { length: 8 },
      (_, index) => `${index + 1}. Item ${index + 1}: ${"x".repeat(25)}`,
    ),
    "    - nested child",
  ].join("\n");
  const listChunks = splitMarkdown(list, 100);
  assert.ok(listChunks.every((chunk) => chunk.length <= 100));
  assert.equal(listChunks.join("\n"), list);
  assert.ok(
    listChunks.slice(1).every((chunk) => /^\d+\. /.test(chunk)),
  );
  assert.match(listChunks.at(-1)!, /\n    - nested child$/);
});

test("streaming splits lists only between top-level items", async () => {
  const { sender, sent } = senderFixture({
    textChunkLimit: 180,
    streamMinChars: 100,
  });
  const reply = sender.createReply(inboundMessage());
  const firstItem = `1. First item ${"x".repeat(90)}\n    - nested detail\n`;
  const secondItem = `2. Second item ${"y".repeat(80)}\n\n`;

  await reply.write(`# Steps\n\n${firstItem}${secondItem}`);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.text, `# Steps\n\n${firstItem.trimEnd()}`);
  assert.equal(sent[0]!.markdown, true);

  await reply.finish();
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.text, secondItem.trim());
  assert.deepEqual(sent.map(({ sequence }) => sequence), [1, 2]);
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

test("truncation keeps the final native fenced-code chunk valid", async () => {
  const { sender, sent } = senderFixture({
    textChunkLimit: 100,
    streamResponses: false,
  });
  const response = [
    "```js",
    ...Array.from(
      { length: 20 },
      (_, index) => `const value${index} = "${"x".repeat(25)}";`,
    ),
    "```",
  ].join("\n");

  await sender.reply(inboundMessage(), response);

  assert.equal(sent.length, 5);
  assert.ok(sent.every(({ text, markdown }) => text.length <= 100 && markdown));
  assert.match(
    sent[4]!.text,
    /^```js\n[\s\S]*\n```\n\nResponse truncated:/,
  );
});

test("direct and group Markdown use QQ msg_type 2 payloads", () => {
  for (const chatType of ["direct", "group"] as const) {
    assert.deepEqual(
      buildTextMessageBody({
        chatType,
        targetId: "target",
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
  }
});

test("raw and native modes preserve supported Markdown syntax", async () => {
  const response = "# Title\n\nUse `bin/tool`.\n\n```sh\necho ok\n```";

  for (const markdownMode of ["raw", "native"] as const) {
    const { sender, sent } = senderFixture({
      markdownMode,
      streamResponses: false,
    });
    await sender.reply(inboundMessage(), response);

    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.text, response);
    assert.equal(sent[0]!.markdown, markdownMode === "native");
  }
});

test("channels use the explicit plain-text compatibility path", async () => {
  const { sender, sent } = senderFixture({ streamResponses: false });
  await sender.reply(
    inboundMessage("channel"),
    "# Title\n\n**Bold** and `code`.\n\n```sh\necho ok\n```",
  );

  assert.deepEqual(
    sent.map(({ text, markdown }) => ({ text, markdown })),
    [{
      text: "Title\n\nBold and code.\n\nCode (sh):\necho ok",
      markdown: false,
    }],
  );
});

test("send failures propagate without a duplicate fallback reply", async () => {
  const config = createInitialConfig({
    appId: "app",
    clientSecretFile: "/unused",
    agentCommand: "agent",
  });
  let attempts = 0;
  const sender = new QQSender(
    {
      sendText: async () => {
        attempts++;
        throw new Error("QQ rejected Markdown");
      },
      uploadMedia: async () => "unused",
      sendMedia: async () => "unused",
    },
    () => config,
  );

  await assert.rejects(
    sender.reply(inboundMessage(), "# One reply"),
    /QQ rejected Markdown/,
  );
  assert.equal(attempts, 1);
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

function inboundMessage(
  chatType: QQInboundMessage["chatType"] = "direct",
): QQInboundMessage {
  return {
    accountId: "app",
    conversationId: "conversation",
    chatType,
    senderId: "user",
    targetId: "user",
    messageId: "inbound",
    timestamp: "2026-08-27T00:00:00Z",
    text: "hello",
    attachments: [],
  };
}
