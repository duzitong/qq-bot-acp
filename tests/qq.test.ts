import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createInitialConfig, type BotConfig } from "../src/config/schema.js";
import {
  buildMediaUploadBody,
  buildMediaMessageBody,
  buildStreamMessageBody,
  buildTextMessageBody,
  parseStreamMessageResponse,
  QQApi,
  type QQSendMediaInput,
  type QQSendStreamInput,
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

const NINE_MINUTES_MS = 9 * 60_000;

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

test("complete replies bypass streaming while preserving formatting and chunk routing", async () => {
  const response = `# Session config\n\n${"Available option\n\n".repeat(16)}`;
  for (const chatType of ["direct", "group", "channel"] as const) {
    for (const markdownMode of ["native", "raw", "plain"] as const) {
      const { sender, sent, streams } = senderFixture({
        markdownMode,
        textChunkLimit: 180,
        streamMinChars: 100,
      });
      const message = inboundMessage(chatType, "command", "command-target");

      await sender.reply(message, response);

      const effectiveMode =
        chatType === "channel" && markdownMode === "native"
          ? "plain"
          : markdownMode;
      const rendered = effectiveMode === "plain"
        ? renderMarkdownForQQ(response)
        : effectiveMode === "native"
          ? renderNativeMarkdownForQQ(response)
          : response.trim();
      const chunks = effectiveMode === "plain"
        ? splitText(rendered, 180)
        : splitMarkdown(rendered, 180);
      assert.ok(chunks.length > 1);
      assert.deepEqual(streams, []);
      assert.deepEqual(sent, chunks.map((text, index) => ({
        chatType,
        targetId: "command-target",
        text,
        replyToId: "command",
        sequence: index + 1,
        markdown: effectiveMode === "native",
      })));
      assert.ok(sent.every(({ text }) => text.length <= 180));
    }
  }
});

test("complete replies do not disable streaming for subsequent agent replies", async () => {
  const { sender, sent, streams } = senderFixture();

  await sender.reply(inboundMessage("direct", "command"), "Current config");
  assert.equal(sent.length, 1);
  assert.equal(streams.length, 0);

  const reply = sender.createReply(inboundMessage("direct", "agent"));
  await reply.write("Partial");
  await reply.flush();
  assert.equal(streams.length, 1);
  assert.equal(streams[0]!.state, 1);
  await reply.write(" answer");
  await reply.finish();

  assert.equal(sent.length, 1);
  assert.deepEqual(streams.map(({ replyToId, state }) => ({ replyToId, state })), [
    { replyToId: "agent", state: 1 },
    { replyToId: "agent", state: 10 },
  ]);
  assert.match(streams[1]!.text, /^Partial answer/);
});

test("direct replies use one official QQ stream from first update through completion", async () => {
  const { sender, sent, streams } = senderFixture();
  const reply = sender.createReply(inboundMessage());

  await reply.write("# Overview\n\nFirst");
  await waitForStreamUpdate();
  await reply.write(" answer.");
  await waitForStreamUpdate();
  await reply.finish();

  assert.equal(sent.length, 0);
  assert.deepEqual(
    streams.map((stream) => ({
      text: stream.text,
      replyToId: stream.replyToId,
      sequence: stream.sequence,
      index: stream.index,
      state: stream.state,
      contentType: stream.contentType,
      streamMessageId: stream.streamMessageId,
    })),
    [
      {
        text: "# Overview\n\nFirst",
        replyToId: "inbound",
        sequence: 1,
        index: 0,
        state: 1,
        contentType: "markdown",
        streamMessageId: undefined,
      },
      {
        text: "# Overview\n\nFirst answer.",
        replyToId: "inbound",
        sequence: 1,
        index: 1,
        state: 1,
        contentType: "markdown",
        streamMessageId: "stream-inbound",
      },
      {
        text: "# Overview\n\nFirst answer.\n\n🔚",
        replyToId: "inbound",
        sequence: 1,
        index: 2,
        state: 10,
        contentType: "markdown",
        streamMessageId: "stream-inbound",
      },
    ],
  );
});

test("official direct streams ignore the legacy text chunk limit", async () => {
  const { sender, sent, streams } = senderFixture({
    textChunkLimit: 100,
  });
  const reply = sender.createReply(inboundMessage());
  const response = `# Long answer\n\n${"x".repeat(500)}`;

  await reply.write(response);
  await reply.finish();

  assert.equal(sent.length, 0);
  assert.equal(streams.length, 2);
  assert.deepEqual(streams.map((frame) => frame.state), [1, 10]);
  assert.deepEqual(streams.map((frame) => frame.index), [0, 1]);
  assert.equal(streams[0]!.streamMessageId, undefined);
  assert.equal(streams[1]!.streamMessageId, "stream-inbound");
  assert.match(streams[1]!.text, /^# Long answer\n\nx{500}/);
  assert.doesNotMatch(streams[1]!.text, /truncated/i);
});

test("streaming diagnostic bypasses ACP and emits visible timed frames", async () => {
  const { sender, streams, logs } = senderFixture({
    markdownMode: "plain",
    streamResponses: false,
  });
  const pauses: number[] = [];

  await sender.runStreamingDiagnostic(
    inboundMessage(),
    async (milliseconds) => {
      pauses.push(milliseconds);
    },
  );

  assert.deepEqual(pauses, [1_000, 1_000, 1_000]);
  assert.deepEqual(streams.map(({ index }) => index), [0, 1, 2, 3]);
  assert.deepEqual(streams.map(({ state }) => state), [1, 1, 1, 10]);
  assert.ok(streams.every(({ contentType }) => contentType === "markdown"));
  assert.ok(streams.slice(1).every(
    ({ streamMessageId }) => streamMessageId === "stream-inbound",
  ));
  assert.ok(streams.every(
    ({ replyToId, sequence }) => replyToId === "inbound" && sequence === 1,
  ));
  assert.match(streams[0]!.text, /1\. First generating frame accepted\.$/);
  assert.match(streams[1]!.text, /2\. Second generating frame accepted/);
  assert.match(streams[2]!.text, /3\. Third generating frame accepted/);
  assert.match(streams[3]!.text, /3\. Third generating frame accepted[\s\S]*🔚$/);
  assert.equal(
    logs.filter((entry) => entry.includes("frame accepted")).length,
    4,
  );
  assert.ok(logs.every((entry) => !entry.includes(streams[0]!.text)));

  await assert.rejects(
    sender.runStreamingDiagnostic(inboundMessage("group"), async () => {}),
    /require a direct chat/,
  );
});

test("remain_msg_len is pending telemetry and never stops a QQ stream", async () => {
  const { sender, streams, logs } = senderFixture({}, async (input) => ({
    id: `stream-${input.replyToId}`,
    pendingCharacters: [0, 17, 4, 0][input.index],
  }));

  await sender.runStreamingDiagnostic(inboundMessage(), async () => {});

  assert.deepEqual(streams.map(({ index }) => index), [0, 1, 2, 3]);
  assert.deepEqual(streams.map(({ state }) => state), [1, 1, 1, 10]);
  assert.deepEqual(
    logs
      .filter((entry) => entry.includes("frame accepted"))
      .map((entry) => entry.match(/pending=(\d+)$/)?.[1]),
    ["0", "17", "4", "0"],
  );
  assert.match(streams.at(-1)!.text, /🔚$/);
});

test("direct streams rotate after exactly nine minutes, even while idle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { sender, sent, streams } = senderFixture();
  const reply = sender.createReply(inboundMessage());

  await tickTimers(t, NINE_MINUTES_MS * 2);
  assert.equal(streams.length, 0);
  await reply.write("First part");
  await reply.flush();
  await tickTimers(t, NINE_MINUTES_MS - 1);
  assert.equal(streams.length, 1);
  await tickTimers(t, 1);

  assert.deepEqual(
    streams.map(({ sequence, index, state, text, streamMessageId }) => ({
      sequence, index, state, text, streamMessageId,
    })),
    [
      { sequence: 1, index: 0, state: 1, text: "First part", streamMessageId: undefined },
      { sequence: 1, index: 1, state: 10, text: "First part\n\n⏩", streamMessageId: "stream-inbound" },
      { sequence: 2, index: 0, state: 1, text: "…", streamMessageId: undefined },
    ],
  );
  await reply.write("Second part");
  await reply.flush();
  await reply.finish();
  await reply.finish();

  assert.deepEqual(streams.slice(3).map(({ sequence, index, state, text, streamMessageId }) => ({
    sequence, index, state, text, streamMessageId,
  })), [
    { sequence: 2, index: 1, state: 1, text: "…\n\nSecond part", streamMessageId: "stream-inbound-2" },
    { sequence: 2, index: 2, state: 10, text: "…\n\nSecond part\n\n🔚", streamMessageId: "stream-inbound-2" },
  ]);
  assert.ok(streams.every(({ targetId, replyToId }) => targetId === "user" && replyToId === "inbound"));
  assert.equal(sent.length, 0);
  await tickTimers(t, NINE_MINUTES_MS * 2);
  assert.equal(streams.length, 5);
});

test("stream updates do not extend rotation deadlines and idle continuations rotate again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { sender, streams } = senderFixture();
  const reply = sender.createReply(inboundMessage());

  await reply.write("First");
  await reply.flush();
  await tickTimers(t, 8 * 60_000);
  await reply.write(" update");
  await reply.flush();
  await tickTimers(t, 60_000 - 1);
  assert.equal(streams.length, 2);
  await tickTimers(t, 1);
  assert.equal(streams[2]!.text, "First update\n\n⏩");
  assert.equal(streams[3]!.text, "…");

  await tickTimers(t, NINE_MINUTES_MS - 1);
  assert.equal(streams.length, 4);
  await tickTimers(t, 1);
  assert.deepEqual(streams.slice(4).map(({ sequence, index, state, text }) => ({
    sequence, index, state, text,
  })), [
    { sequence: 2, index: 1, state: 10, text: "…\n\n⏩" },
    { sequence: 3, index: 0, state: 1, text: "…" },
  ]);
  await reply.finish();
  assert.equal(streams.at(-1)!.text, "…\n\n🔚");
});

test("rotation counts first-request latency rather than starting at its acknowledgement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let acceptFirst!: () => void;
  const firstResponse = new Promise<void>((resolve) => { acceptFirst = resolve; });
  const { sender, streams } = senderFixture({}, async (input) => {
    if (input.sequence === 1 && input.index === 0) await firstResponse;
    return { id: `stream-${input.sequence}` };
  });
  const reply = sender.createReply(inboundMessage());
  await reply.write("First");
  const flushing = reply.flush();
  await tickTimers(t, 0);
  assert.equal(streams.length, 1);
  await tickTimers(t, 60_000);
  acceptFirst();
  await flushing;

  await tickTimers(t, 8 * 60_000 - 1);
  assert.equal(streams.length, 1);
  await tickTimers(t, 1);
  assert.deepEqual(streams.map(({ sequence, state }) => ({ sequence, state })), [
    { sequence: 1, state: 1 },
    { sequence: 1, state: 10 },
    { sequence: 2, state: 1 },
  ]);
  await reply.finish();
});

test("rotation carries unfinished Markdown and LaTeX into the next stream without replaying text", async (t) => {
  const cases = [
    { opening: "```ts\nconst answer =", closing: " 42;\n```", rendered: "```ts\nconst answer = 42;\n```" },
    { opening: "\\[\nx^", closing: "2\n\\]", rendered: "x²" },
    { opening: "\\", closing: "(x^2\\)", rendered: "x²" },
    { opening: "`unfin", closing: "ished`", rendered: "`unfinished`" },
    { opening: "$x$", closing: " + 1", rendered: "x + 1" },
  ];
  for (const markdownMode of ["native", "raw"] as const) {
    for (const { opening, closing, rendered } of cases) {
      await t.test(`${markdownMode}: ${JSON.stringify(opening)}`, async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
        const { sender, streams } = senderFixture({ markdownMode });
        const reply = sender.createReply(inboundMessage());
        await reply.write(`Before 😀\n\n${opening}`);
        await reply.flush();
        assert.equal(streams[0]!.text, "Before 😀");
        await tickTimers(t, NINE_MINUTES_MS);
        assert.equal(streams[1]!.text, "Before 😀\n\n⏩");
        await reply.write(`${closing}\n\nAfter`);
        await reply.finish();

        const body = markdownMode === "raw" ? opening + closing : rendered;
        assert.equal(streams.at(-1)!.text, `…\n\n${body}\n\nAfter\n\n🔚`);
        assert.equal(streams.at(-1)!.sequence, 2);
        assert.equal(streams.at(-1)!.contentType, markdownMode === "native" ? "markdown" : "text");
        assert.doesNotMatch(streams.at(-1)!.text, /Before/);
      });
    }
  }
});

test("repeated rotations and artifacts share sequences beyond four replies", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { sender, streams, media, sent } = senderFixture();
  const reply = sender.createReply(inboundMessage());

  for (let part = 1; part <= 5; part++) {
    await reply.write(`Part ${part}`);
    await reply.flush();
    if (part <= 2) await reply.sendArtifact(artifact(`file-${part}`, `file-${part}.png`));
    if (part < 5) await tickTimers(t, NINE_MINUTES_MS);
  }
  await reply.finish();

  assert.deepEqual(media.map(({ sequence }) => sequence), [2, 4]);
  const starts = streams.filter(({ index }) => index === 0);
  assert.deepEqual(starts.map(({ sequence }) => sequence), [1, 3, 5, 6, 7]);
  assert.ok(starts.every(({ streamMessageId }) => streamMessageId === undefined));
  const endings = streams.filter(({ state }) => state === 10);
  assert.deepEqual(endings.map(({ text }) => text), [
    "Part 1\n\n⏩",
    "…\n\nPart 2\n\n⏩",
    "…\n\nPart 3\n\n⏩",
    "…\n\nPart 4\n\n⏩",
    "…\n\nPart 5\n\n🔚",
  ]);
  assert.equal(new Set(endings.map(({ streamMessageId }) => streamMessageId)).size, 5);
  for (const { sequence } of starts) {
    const frames = streams.filter((frame) => frame.sequence === sequence);
    assert.deepEqual(frames.map(({ index }) => index), frames.map((_, index) => index));
    assert.ok(frames.every(({ replyToId }) => replyToId === "inbound"));
    assert.ok(frames.slice(1).every(({ streamMessageId }) => streamMessageId === frames[1]!.streamMessageId));
    assert.ok(frames.slice(1).every(({ text }, index) => text.startsWith(frames[index]!.text)));
  }
  assert.equal(sent.length, 0);
});

test("interleaved turns rotate independently without rebinding to the latest inbound message", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { sender, streams } = senderFixture();
  const first = sender.createReply(inboundMessage("direct", "first"));
  await first.write("First");
  await first.flush();
  await tickTimers(t, 60_000);
  const second = sender.createReply(inboundMessage("direct", "second"));
  await second.write("Second");
  await second.flush();
  await tickTimers(t, 8 * 60_000);

  assert.deepEqual(streams.filter(({ index }) => index === 0).map(({ replyToId, sequence }) => ({
    replyToId, sequence,
  })), [
    { replyToId: "first", sequence: 1 },
    { replyToId: "second", sequence: 1 },
    { replyToId: "first", sequence: 2 },
  ]);
  await tickTimers(t, 60_000);
  assert.equal(streams.at(-1)!.replyToId, "second");
  assert.equal(streams.at(-1)!.sequence, 2);
  await Promise.all([first.finish(), second.finish()]);
  assert.deepEqual(streams.slice(-2).map(({ replyToId, streamMessageId }) => ({
    replyToId, streamMessageId,
  })), [
    { replyToId: "first", streamMessageId: "stream-first-2" },
    { replyToId: "second", streamMessageId: "stream-second-2" },
  ]);
});

test("rotation failures stop timers and surface without retries or fallback replies", async (t) => {
  for (const phase of ["close-old", "open-new"] as const) {
    await t.test(phase, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      const { sender, streams, sent, uploads, logs } = senderFixture({}, async (input) => {
        if (
          (phase === "close-old" && input.state === 10) ||
          (phase === "open-new" && input.sequence === 2)
        ) {
          throw new Error("QQ stream send failed (400; code 40054007)");
        }
        return { id: `stream-${input.sequence}` };
      });
      const reply = sender.createReply(inboundMessage());
      await reply.write("Partial");
      await reply.flush();
      await tickTimers(t, NINE_MINUTES_MS);
      const attempts = phase === "close-old" ? 2 : 3;
      assert.equal(streams.length, attempts);
      await assert.rejects(reply.write("Late"), /code 40054007/);
      await assert.rejects(reply.flush(), /code 40054007/);
      await assert.rejects(reply.sendArtifact(artifact("file", "file.png")), /code 40054007/);
      await assert.rejects(reply.finish(), /code 40054007/);
      await tickTimers(t, NINE_MINUTES_MS * 2);
      assert.equal(streams.length, attempts);
      assert.equal(sent.length, 0);
      assert.equal(uploads.length, 0);
      assert.match(logs.at(-1)!, /error=http-400$/);
      assert.ok(logs.every((entry) => !entry.includes("Partial")));
    });
  }
});

test("disposing a reply stops its timers and prevents a new stream after an in-flight close", async (t) => {
  for (const phase of ["opening", "idle", "closing", "finishing"]) {
    await t.test(phase, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      let acceptRequest!: () => void;
      const response = new Promise<void>((resolve) => { acceptRequest = resolve; });
      const { sender, streams } = senderFixture({}, async (input) => {
        if (
          ((phase === "opening" || phase === "finishing") && input.index === 0) ||
          (phase === "closing" && input.state === 10)
        ) {
          await response;
        }
        return { id: `stream-${input.sequence}` };
      });
      const reply = sender.createReply(inboundMessage());
      await reply.write("Partial");
      const sending = phase === "finishing" ? reply.finish() : reply.flush();
      await tickTimers(t, 0);
      if (phase === "closing") await tickTimers(t, NINE_MINUTES_MS);
      reply.dispose();
      acceptRequest();
      await sending;
      await tickTimers(t, NINE_MINUTES_MS * 2);
      assert.equal(streams.length, phase === "closing" ? 2 : 1);
      await assert.rejects(reply.write("Late"), /finished QQ reply/);
      await reply.finish();
      assert.ok(streams.every(({ text }) => !text.includes("🔚")));
    });
  }
});

test("finishing clears the rotation deadline while the final request is still in flight", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let acceptFinal!: () => void;
  const finalResponse = new Promise<void>((resolve) => { acceptFinal = resolve; });
  const { sender, streams } = senderFixture({}, async (input) => {
    if (input.state === 10) await finalResponse;
    return { id: "stream" };
  });
  const reply = sender.createReply(inboundMessage());
  await reply.write("Complete");
  await reply.flush();
  const finishing = reply.finish();
  await tickTimers(t, 0);
  await tickTimers(t, NINE_MINUTES_MS);
  assert.equal(streams.length, 2);
  acceptFinal();
  await finishing;
  await tickTimers(t, NINE_MINUTES_MS);
  assert.deepEqual(streams.map(({ state }) => state), [1, 10]);
  assert.equal(streams[1]!.text, "Complete\n\n🔚");
});

test("non-streaming replies and final-only plain rendering do not start rotation timers", async (t) => {
  for (const chatType of ["direct", "group", "channel"] as const) {
    for (const streamResponses of [false, true]) {
      await t.test(`${chatType}: streaming=${streamResponses}`, async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
        const { sender, streams, sent } = senderFixture({
          streamResponses,
          markdownMode: "plain",
        });
        const reply = sender.createReply(inboundMessage(chatType));
        await reply.write("**Complete**");
        await tickTimers(t, NINE_MINUTES_MS * 2);
        assert.equal(streams.length, 0);
        assert.equal(sent.length, 0);
        await reply.finish();
        await tickTimers(t, NINE_MINUTES_MS * 2);
        if (chatType === "direct" && streamResponses) {
          assert.deepEqual(streams.map(({ text }) => text), ["Complete", "Complete\n\n🔚"]);
        } else {
          assert.equal(streams.length, 0);
          assert.deepEqual(sent.map(({ text }) => text), ["Complete"]);
        }
      });
    }
  }
});

test("interrupted streaming diagnostics dispose their stream timers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { sender, streams } = senderFixture();
  await assert.rejects(sender.runStreamingDiagnostic(inboundMessage(), async () => {
    throw new Error("Diagnostic interrupted");
  }), /Diagnostic interrupted/);
  await tickTimers(t, NINE_MINUTES_MS * 2);
  assert.equal(streams.length, 1);
});

test("direct streaming preserves Markdown and LaTeX across ACP delta boundaries", async () => {
  const { sender, streams } = senderFixture();
  const reply = sender.createReply(inboundMessage());

  await reply.write("# Result\n\n\\[\nmatch(x,g)=\\text{x");
  await waitForStreamUpdate();
  assert.equal(streams.length, 1);
  assert.equal(streams[0]!.text, "# Result");

  await reply.write("与猜测g相同的个数}\n\\]\n\n```ts\nconst x =");
  await waitForStreamUpdate();
  assert.equal(streams.length, 2);
  assert.equal(
    streams[1]!.text,
    "# Result\n\nmatch(x, g) = x与猜测g相同的个数",
  );

  await reply.write(" 1;\n```\n");
  await reply.finish();
  assert.match(
    streams.at(-1)!.text,
    /match\(x, g\) = x与猜测g相同的个数\n\n```ts\nconst x = 1;\n```/,
  );
  assert.equal(streams.at(-1)!.state, 10);
});

test("direct streaming handles a LaTeX opener split after its backslash", async () => {
  const { sender, streams } = senderFixture();
  const reply = sender.createReply(inboundMessage());

  await reply.write("Value: \\");
  await waitForStreamUpdate();
  assert.equal(streams[0]!.text, "Value:");

  await reply.write("(x^2");
  await waitForStreamUpdate();
  assert.equal(streams.length, 1);

  await reply.write("\\) done");
  await reply.finish();
  assert.match(streams.at(-1)!.text, /^Value: x² done/);
  assert.equal(streams.at(-1)!.state, 10);
});

test("direct streaming waits for lookahead after an inline-dollar close", async () => {
  const { sender, streams } = senderFixture();
  const reply = sender.createReply(inboundMessage());

  await reply.write("Value $x$");
  await waitForStreamUpdate();
  assert.equal(streams[0]!.text, "Value");

  await reply.write("2");
  await waitForStreamUpdate();
  assert.equal(streams.length, 1);

  await reply.finish();
  assert.match(streams.at(-1)!.text, /^Value \$x\$2/);
  assert.equal(streams.at(-1)!.state, 10);
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

test("group fallback batching splits lists only between top-level items", async () => {
  const { sender, sent } = senderFixture({
    textChunkLimit: 180,
    streamMinChars: 100,
  });
  const reply = sender.createReply(inboundMessage("group"));
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

test("complete replies retain group/channel limits but do not cap direct replies at four", async () => {
  for (const chatType of ["direct", "group", "channel"] as const) {
    const { sender, sent, streams } = senderFixture({ textChunkLimit: 100 });

    await sender.reply(inboundMessage(chatType), "x".repeat(650));

    const maximum = chatType === "direct" ? 7 : 5;
    assert.equal(sent.length, maximum);
    assert.deepEqual(
      sent.map(({ sequence }) => sequence),
      Array.from({ length: maximum }, (_, index) => index + 1),
    );
    if (chatType === "direct") {
      assert.equal(sent.map(({ text }) => text).join(""), "x".repeat(650));
    } else {
      assert.match(sent.at(-1)!.text, /Response truncated/);
    }
    assert.ok(sent.every(({ text }) => text.length <= 100));
    assert.equal(streams.length, 0);
  }
});

test("non-streaming direct replies allow twenty chunks without an invented local quota", async () => {
  const { sender, sent } = senderFixture({
    textChunkLimit: 100,
    streamResponses: false,
  });

  const reply = sender.createReply(inboundMessage());
  await reply.write("x".repeat(2_000));
  assert.equal(sent.length, 0);
  await reply.finish();

  assert.equal(sent.length, 20);
  assert.deepEqual(sent.map(({ sequence }) => sequence), Array.from({ length: 20 }, (_, index) => index + 1));
  assert.equal(sent.map(({ text }) => text).join(""), "x".repeat(2_000));
});

test("truncation keeps the final native fenced-code chunk valid", async () => {
  const { sender, sent } = senderFixture({
    textChunkLimit: 100,
  });
  const response = [
    "```js",
    ...Array.from(
      { length: 20 },
      (_, index) => `const value${index} = "${"x".repeat(25)}";`,
    ),
    "```",
  ].join("\n");

  await sender.reply(inboundMessage("group"), response);

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

test("QQ stream request bodies and responses follow the official contract", () => {
  const base: QQSendStreamInput = {
    targetId: "user",
    text: "# Answer",
    replyToId: "inbound",
    sequence: 2,
    index: 0,
    state: 1,
    contentType: "markdown",
  };
  assert.deepEqual(buildStreamMessageBody(base), {
    input_mode: "replace",
    input_state: 1,
    index: 0,
    content_type: "markdown",
    content_raw: "# Answer",
    msg_id: "inbound",
    msg_seq: 2,
  });

  assert.deepEqual(
    buildStreamMessageBody({
      ...base,
      text: "# Answer\n\nDone",
      index: 1,
      state: 10,
      streamMessageId: "stream-1",
    }),
    {
      input_mode: "replace",
      input_state: 10,
      index: 1,
      content_type: "markdown",
      content_raw: "# Answer\n\nDone",
      msg_id: "inbound",
      stream_msg_id: "stream-1",
      msg_seq: 2,
    },
  );
  assert.deepEqual(
    parseStreamMessageResponse({ id: "stream-1", remain_msg_len: 1234 }),
    { id: "stream-1", pendingCharacters: 1234 },
  );
  assert.throws(
    () => parseStreamMessageResponse({ remain_msg_len: 1234 }),
    /did not include a message ID/,
  );
  assert.throws(
    () => parseStreamMessageResponse({ id: "stream-1", remain_msg_len: -1 }),
    /invalid remaining length/,
  );
});

test("QQ API posts stream frames to the direct stream endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/getAppAccessToken")) {
      return new Response(JSON.stringify({
        access_token: "token",
        expires_in: 7200,
      }), { status: 200 });
    }
    requests.push({
      url,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({
      id: "stream-1",
      remain_msg_len: 999,
    }), { status: 200 });
  };

  try {
    const response = await new QQApi("app", "secret").sendStream({
      targetId: "user/with/slash",
      text: "Answer",
      replyToId: "inbound",
      sequence: 1,
      index: 0,
      state: 1,
      contentType: "markdown",
    });
    assert.deepEqual(response, {
      id: "stream-1",
      pendingCharacters: 999,
    });
    assert.equal(
      requests[0]?.url,
      "https://api.sgroup.qq.com/v2/users/user%2Fwith%2Fslash/stream_messages",
    );
    assert.deepEqual(requests[0]?.body, {
      input_mode: "replace",
      input_state: 1,
      index: 0,
      content_type: "markdown",
      content_raw: "Answer",
      msg_id: "inbound",
      msg_seq: 1,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("interleaved turns retain their own inbound and stream message IDs", async () => {
  const { sender, streams } = senderFixture();
  const first = sender.createReply(inboundMessage("direct", "inbound-a", "user-a"));
  const second = sender.createReply(inboundMessage("direct", "inbound-b", "user-b"));

  await Promise.all([first.write("First"), second.write("Second")]);
  await waitForStreamUpdate();
  await Promise.all([first.write(" A"), second.write(" B")]);
  await waitForStreamUpdate();
  await Promise.all([first.finish(), second.finish()]);

  const firstFrames = streams.filter((frame) => frame.replyToId === "inbound-a");
  const secondFrames = streams.filter((frame) => frame.replyToId === "inbound-b");
  assert.deepEqual(firstFrames.map((frame) => frame.targetId), [
    "user-a", "user-a", "user-a",
  ]);
  assert.deepEqual(secondFrames.map((frame) => frame.targetId), [
    "user-b", "user-b", "user-b",
  ]);
  assert.ok(firstFrames.slice(1).every(
    (frame) => frame.streamMessageId === "stream-inbound-a",
  ));
  assert.ok(secondFrames.slice(1).every(
    (frame) => frame.streamMessageId === "stream-inbound-b",
  ));
});

test("raw and native modes preserve supported Markdown syntax", async () => {
  const response = "# Title\n\nUse `bin/tool`.\n\n```sh\necho ok\n```";

  for (const markdownMode of ["raw", "native"] as const) {
    const { sender, sent } = senderFixture({
      markdownMode,
    });
    await sender.reply(inboundMessage(), response);

    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.text, response);
    assert.equal(sent[0]!.markdown, markdownMode === "native");
  }
});

test("channels use the explicit plain-text compatibility path", async () => {
  const { sender, sent } = senderFixture();
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
      sendStream: async () => {
        attempts++;
        throw new Error("QQ rejected stream");
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

test("stream update failures surface without sending a fallback reply", async () => {
  let attempts = 0;
  const { sender, sent, logs } = senderFixture({}, async () => {
    attempts++;
    throw new Error("QQ stream unavailable with sensitive response");
  });
  const reply = sender.createReply(inboundMessage());

  await reply.write("Partial");
  await waitForStreamUpdate();
  await assert.rejects(reply.finish(), /QQ stream unavailable/);
  assert.equal(attempts, 1);
  assert.equal(sent.length, 0);
  assert.match(logs.at(-1)!, /error=request-error$/);
  assert.doesNotMatch(logs.at(-1)!, /sensitive response/);
});

test("an explicit QQ length rejection surfaces without local truncation", async () => {
  const { sender, sent, streams, logs } = senderFixture({}, async (input) => {
    if (input.index === 1) {
      throw new Error("QQ stream send failed (400; code 40054007)");
    }
    return {
      id: `stream-${input.replyToId}`,
      pendingCharacters: 0,
    };
  });
  const reply = sender.createReply(inboundMessage());

  await reply.write("start");
  await waitForStreamUpdate();
  await reply.write("x".repeat(200));
  await waitForStreamUpdate();

  await assert.rejects(reply.finish(), /code 40054007/);
  assert.equal(sent.length, 0);
  assert.deepEqual(streams.map(({ index }) => index), [0, 1]);
  assert.match(streams[1]!.text, /^startx{200}$/);
  assert.match(logs.at(-1)!, /error=http-400$/);
});

test("plain compatibility rendering waits for a prefix-safe final frame", async () => {
  const { sender, streams } = senderFixture({ markdownMode: "plain" });
  const reply = sender.createReply(inboundMessage());

  await reply.write("**bold");
  await waitForStreamUpdate();
  assert.equal(streams.length, 0);
  await reply.write("** and `code`");
  await waitForStreamUpdate();
  assert.equal(streams.length, 0);
  await reply.finish();

  assert.equal(streams.length, 2);
  assert.equal(streams[0]!.contentType, "text");
  assert.deepEqual(streams.map((frame) => frame.state), [1, 10]);
  assert.equal(streams[0]!.text, "bold and code");
  assert.equal(streams[1]!.text, "bold and code\n\n🔚");
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
    buildMediaUploadBody(
      Buffer.from([0, 1, 2]),
      4,
      "report: 2026.pdf",
    ),
    {
      file_type: 4,
      file_data: "AAEC",
      file_name: "report_ 2026.pdf",
      srv_send_msg: false,
    },
  );
  assert.throws(
    () => buildMediaUploadBody(Buffer.from([0, 1, 2]), 4),
    /require a file name/,
  );
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

test("ordinary artifacts preserve their file name and use QQ file uploads", async () => {
  const { sender, uploads, media } = senderFixture({ streamResponses: false });
  const reply = sender.createReply(inboundMessage());

  await reply.sendArtifact(artifact("document", "report.pdf"), "Final report");
  await reply.finish();

  assert.equal(uploads.length, 1);
  assert.equal(uploads[0]?.fileType, 4);
  assert.equal(uploads[0]?.fileName, "report.pdf");
  assert.equal(media[0]?.caption, "Final report");
});

test("artifacts share reply sequencing and are deduplicated per turn", async () => {
  const { sender, sent, streams, uploads, media, operations } = senderFixture();
  const reply = sender.createReply(inboundMessage());
  const video = artifact("video", "clip.mp4");
  const voice = artifact("voice", "voice.silk");

  await reply.write(`${"a".repeat(110)}\n\n`);
  await waitForStreamUpdate();
  assert.deepEqual(streams.map(({ sequence }) => sequence), [1]);

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
  assert.equal(sent.length, 0);
  assert.ok(streams.every(({ sequence }) => sequence === 1));
  assert.deepEqual(
    operations,
    [
      "stream:1:0",
      "upload:video",
      "media:2",
      "upload:voice",
      "media:3",
      "stream:1:1",
    ],
  );
});

function senderFixture(
  output: Partial<BotConfig["output"]> = {},
  streamResponse?: (
    input: QQSendStreamInput,
  ) => Promise<{ id: string; pendingCharacters?: number }>,
) {
  const config = createInitialConfig({
    appId: "app",
    clientSecretFile: "/unused",
    agentCommand: "agent",
  });
  config.output = { ...config.output, ...output };
  const sent: QQSendTextInput[] = [];
  const streams: QQSendStreamInput[] = [];
  const uploads: QQUploadMediaInput[] = [];
  const media: QQSendMediaInput[] = [];
  const operations: string[] = [];
  const logs: string[] = [];
  const sender = new QQSender(
    {
      sendText: async (input) => {
        sent.push(input);
        operations.push(`text:${input.sequence}`);
        return `message-${sent.length}`;
      },
      sendStream: async (input) => {
        streams.push(input);
        operations.push(`stream:${input.sequence}:${input.index}`);
        return streamResponse
          ? streamResponse(input)
          : {
              id: `stream-${input.replyToId}${input.sequence === 1 ? "" : `-${input.sequence}`}`,
              pendingCharacters: 0,
            };
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
    (message) => logs.push(message),
  );
  return { sender, sent, streams, uploads, media, operations, logs };
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
  if (fileName.endsWith(".pdf")) {
    return {
      data: Buffer.from(digest),
      digest,
      fileName,
      kind: "file",
      mimeType: "application/octet-stream",
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
  messageId = "inbound",
  targetId = "user",
): QQInboundMessage {
  return {
    accountId: "app",
    conversationId: "conversation",
    chatType,
    senderId: "user",
    targetId,
    messageId,
    timestamp: "2026-08-27T00:00:00Z",
    text: "hello",
    attachments: [],
  };
}

function waitForStreamUpdate(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 350));
}

async function tickTimers(t: TestContext, milliseconds: number): Promise<void> {
  t.mock.timers.tick(milliseconds);
  await new Promise<void>((resolve) => setImmediate(resolve));
}
