import type {
  ArtifactKind,
  PreparedArtifact,
} from "../artifacts/file.js";
import type { BotConfig } from "../config/schema.js";
import type {
  QQMediaFileType,
  QQSendMediaInput,
  QQSendStreamInput,
  QQStreamMessageResponse,
  QQSendTextInput,
  QQUploadMediaInput,
} from "./api.js";
import {
  findStreamingSplit,
  renderNativeMarkdownForQQ,
  renderMarkdownForQQ,
  splitMarkdown,
  splitText,
  trimBlockStart,
} from "./format.js";
import type { QQInboundMessage } from "./types.js";

const DIRECT_MAX_PASSIVE_REPLIES = 4;
const GROUP_MAX_PASSIVE_REPLIES = 5;
const CHANNEL_MAX_PASSIVE_REPLIES = 5;
const PROGRESSIVE_REPLY_LIMIT = 2;
const FINAL_REPLY_RESERVE = 1;
const MAX_ARTIFACTS_PER_TURN = 2;
const STREAM_LENGTH_MARGIN = 64;
const STREAM_UPDATE_INTERVAL_MS = 300;
const STREAM_EMPTY_PLACEHOLDER = "…";
const STREAM_COMPLETION_MARKER = "\n\n✓ Complete";
const STREAM_COMPLETION_MARKERS = [
  STREAM_COMPLETION_MARKER,
  "\n\n✓",
  "✓",
] as const;
const STREAM_TRUNCATED_MARKER =
  "\n\n⚠ Response truncated · ✓ Complete";
const STREAM_TRUNCATED_MARKERS = [
  STREAM_TRUNCATED_MARKER,
  "\n\n⚠ Truncated · ✓",
  "\n\n⚠ · ✓",
  "\n\n⚠✓",
  "\n\n✓",
  "✓",
  "",
] as const;
const TRUNCATION_NOTICE =
  "Response truncated: QQ's passive reply limit was reached.";

type EffectiveMarkdownMode = BotConfig["output"]["markdownMode"];

export interface QQMessageApi {
  sendText(input: QQSendTextInput): Promise<string | undefined>;
  sendStream(input: QQSendStreamInput): Promise<QQStreamMessageResponse>;
  uploadMedia(input: QQUploadMediaInput): Promise<string>;
  sendMedia(input: QQSendMediaInput): Promise<string | undefined>;
}

export interface QQReplyStream {
  write(text: string): Promise<void>;
  sendArtifact(
    artifact: PreparedArtifact,
    caption?: string,
  ): Promise<{ alreadySent: boolean }>;
  finish(): Promise<void>;
}

export class QQSender {
  constructor(
    private readonly api: QQMessageApi,
    private readonly getConfig: () => BotConfig,
  ) {}

  createReply(message: QQInboundMessage): QQReplyStream {
    return new BufferedQQReply(
      this.api,
      message,
      this.getConfig().output,
    );
  }

  async reply(message: QQInboundMessage, text: string): Promise<void> {
    const reply = this.createReply(message);
    await reply.write(text);
    await reply.finish();
  }
}

class BufferedQQReply implements QQReplyStream {
  private buffer = "";
  private sent = 0;
  private artifactsSent = 0;
  private readonly artifactDigests = new Set<string>();
  private finished = false;
  private operationChain = Promise.resolve();
  private streamMessageId?: string;
  private streamSequence?: number;
  private streamIndex = 0;
  private streamLastText = "";
  private streamRemaining?: number;
  private streamExhausted = false;
  private streamTimer?: ReturnType<typeof setTimeout>;
  private streamError?: unknown;

  constructor(
    private readonly api: QQMessageApi,
    private readonly message: QQInboundMessage,
    private readonly output: BotConfig["output"],
  ) {}

  write(text: string): Promise<void> {
    return this.enqueue(() => this.writeNow(text));
  }

  sendArtifact(
    artifact: PreparedArtifact,
    caption?: string,
  ): Promise<{ alreadySent: boolean }> {
    return this.enqueue(() => this.sendArtifactNow(artifact, caption));
  }

  finish(): Promise<void> {
    return this.enqueue(() => this.finishNow());
  }

  private async writeNow(text: string): Promise<void> {
    if (this.finished) throw new Error("Cannot write to a finished QQ reply");
    if (this.streamError !== undefined) throw this.streamError;
    if (!text) return;
    this.buffer += text;
    if (!this.output.streamResponses) return;
    if (this.usesOfficialStream()) {
      this.scheduleStreamUpdate();
      return;
    }
    await this.flushProgressive();
  }

  private async sendArtifactNow(
    artifact: PreparedArtifact,
    caption?: string,
  ): Promise<{ alreadySent: boolean }> {
    if (this.finished) throw new Error("Cannot send from a finished QQ reply");
    if (this.artifactDigests.has(artifact.digest)) {
      return { alreadySent: true };
    }
    if (this.message.chatType === "channel") {
      throw new Error("QQ artifact delivery is not supported in channel chats");
    }
    if (this.artifactsSent >= MAX_ARTIFACTS_PER_TURN) {
      throw new Error(
        `At most ${MAX_ARTIFACTS_PER_TURN} artifacts can be sent in one QQ turn`,
      );
    }
    if (this.usesOfficialStream()) {
      await this.flushStreamUpdate();
    }
    if (this.sent >= this.maxPassiveReplies() - FINAL_REPLY_RESERVE) {
      throw new Error("No QQ reply slot remains for another artifact");
    }

    const fileInfo = await this.api.uploadMedia({
      chatType: this.message.chatType,
      targetId: this.message.targetId,
      data: artifact.data,
      fileType: qqMediaFileType(artifact.kind),
    });
    await this.api.sendMedia({
      chatType: this.message.chatType,
      targetId: this.message.targetId,
      fileInfo,
      replyToId: this.message.messageId,
      sequence: this.allocateSequence(),
      caption: caption ? renderMarkdownForQQ(caption) : undefined,
    });
    this.artifactsSent++;
    this.artifactDigests.add(artifact.digest);
    return { alreadySent: false };
  }

  private async finishNow(): Promise<void> {
    if (this.finished) return;
    this.clearStreamTimer();
    if (this.streamError !== undefined) throw this.streamError;

    if (this.usesOfficialStream()) {
      await this.finishOfficialStream();
      this.finished = true;
      return;
    }

    const rendered = this.render(this.buffer);
    this.buffer = "";
    const chunks = capReplyChunks(
      this.split(rendered),
      this.maxPassiveReplies() - this.sent,
      this.output.textChunkLimit,
      (text, limit) => this.split(text, limit),
    );
    await this.sendChunks(chunks);
    this.finished = true;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationChain.then(operation);
    this.operationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async flushProgressive(): Promise<void> {
    const maxLength = Math.max(
      this.output.streamMinChars,
      this.output.textChunkLimit - STREAM_LENGTH_MARGIN,
    );

    while (this.sent < PROGRESSIVE_REPLY_LIMIT) {
      const splitAt = findStreamingSplit(
        this.buffer,
        this.output.streamMinChars,
        maxLength,
        this.output.textChunkLimit,
      );
      if (splitAt === undefined) return;

      const raw = this.buffer.slice(0, splitAt).trim();
      const chunks = this.split(this.render(raw));
      if (chunks.length > PROGRESSIVE_REPLY_LIMIT - this.sent) return;

      this.buffer = trimBlockStart(this.buffer.slice(splitAt));
      await this.sendChunks(chunks);
    }
  }

  private usesOfficialStream(): boolean {
    return this.message.chatType === "direct" && this.output.streamResponses;
  }

  private scheduleStreamUpdate(): void {
    if (this.streamTimer || this.streamExhausted) return;
    this.streamTimer = setTimeout(() => {
      this.streamTimer = undefined;
      void this.enqueue(() => this.flushStreamUpdate()).catch((error) => {
        this.streamError = error;
      });
    }, STREAM_UPDATE_INTERVAL_MS);
    this.streamTimer.unref();
  }

  private clearStreamTimer(): void {
    if (this.streamTimer) clearTimeout(this.streamTimer);
    this.streamTimer = undefined;
  }

  private async flushStreamUpdate(): Promise<void> {
    if (this.streamError !== undefined) throw this.streamError;
    if (this.streamExhausted) return;
    const desired = this.renderStreamText();
    if (!desired || desired === this.streamLastText) return;

    const content = this.capGeneratingStreamText(desired);
    if (content === this.streamLastText) return;
    await this.sendStreamFrame(content, 1);
  }

  private async finishOfficialStream(): Promise<void> {
    let desired = this.renderStreamText(true);
    if (this.streamMessageId === undefined) {
      desired ||= STREAM_EMPTY_PLACEHOLDER;
      await this.sendStreamFrame(desired, 1);
    }
    const final = this.capFinalStreamText(desired);
    await this.sendStreamFrame(final, 10);
  }

  private renderStreamText(final = false): string {
    if (!final && this.effectiveMarkdownMode() === "plain") return "";
    const source = final ? this.buffer : streamSafeSource(this.buffer);
    return this.render(source);
  }

  private capGeneratingStreamText(desired: string): string {
    this.assertStreamPrefix(desired);
    if (this.streamRemaining === undefined) return desired;

    const suffix = desired.slice(this.streamLastText.length);
    if (
      countCharacters(suffix) +
        countCharacters(STREAM_COMPLETION_MARKERS.at(-1)!) <=
      this.streamRemaining
    ) {
      return desired;
    }

    this.streamExhausted = true;
    return this.streamLastText;
  }

  private capFinalStreamText(desired: string): string {
    this.assertStreamPrefix(desired);
    const suffix = desired.slice(this.streamLastText.length);
    if (this.streamRemaining === undefined) {
      return `${desired}${STREAM_COMPLETION_MARKER}`;
    }

    const completionMarker = streamCompletionMarker(
      this.streamRemaining - countCharacters(suffix),
    );
    if (
      !this.streamExhausted &&
      completionMarker !== undefined
    ) {
      return `${desired}${completionMarker}`;
    }

    const truncatedMarker = streamTruncatedMarker(this.streamRemaining);
    const contentCapacity = Math.max(
      0,
      this.streamRemaining - countCharacters(truncatedMarker),
    );
    const truncated = truncateStreamText(
      desired,
      this.streamLastText,
      contentCapacity,
      this.effectiveMarkdownMode() === "native",
    );
    return `${truncated}${truncatedMarker}`;
  }

  private assertStreamPrefix(desired: string): void {
    if (!desired.startsWith(this.streamLastText)) {
      throw new Error(
        "QQ stream update would modify content already sent by the platform",
      );
    }
  }

  private async sendStreamFrame(text: string, state: 1 | 10): Promise<void> {
    if (this.streamSequence === undefined) {
      this.streamSequence = this.allocateSequence();
    }
    const previousText = this.streamLastText;
    const previousRemaining = this.streamRemaining;
    const response = await this.api.sendStream({
      targetId: this.message.targetId,
      text,
      replyToId: this.message.messageId,
      sequence: this.streamSequence,
      index: this.streamIndex,
      state,
      contentType:
        this.effectiveMarkdownMode() === "native" ? "markdown" : "text",
      streamMessageId: this.streamMessageId,
    });
    if (
      this.streamMessageId !== undefined &&
      response.id !== this.streamMessageId
    ) {
      throw new Error(
        `QQ stream message ID changed from ${this.streamMessageId} to ${response.id}`,
      );
    }
    this.streamMessageId ??= response.id;
    this.streamIndex++;
    this.streamLastText = text;
    this.streamRemaining =
      response.remainMessageLength ??
      (previousRemaining === undefined
        ? undefined
        : Math.max(
            0,
            previousRemaining -
              countCharacters(text.slice(previousText.length)),
          ));
  }

  private render(text: string): string {
    switch (this.effectiveMarkdownMode()) {
      case "plain":
        return renderMarkdownForQQ(text);
      case "native":
        return renderNativeMarkdownForQQ(text);
      case "raw":
        return text.trim();
    }
  }

  private split(
    text: string,
    limit = this.output.textChunkLimit,
  ): string[] {
    return this.effectiveMarkdownMode() === "plain"
      ? splitText(text, limit)
      : splitMarkdown(text, limit);
  }

  private effectiveMarkdownMode(): EffectiveMarkdownMode {
    return (
      this.output.markdownMode === "native" &&
      this.message.chatType === "channel"
    )
      ? "plain"
      : this.output.markdownMode;
  }

  private async sendChunks(chunks: string[]): Promise<void> {
    for (const text of chunks) {
      await this.api.sendText({
        chatType: this.message.chatType,
        targetId: this.message.targetId,
        text,
        replyToId: this.message.messageId,
        sequence: this.allocateSequence(),
        markdown: this.effectiveMarkdownMode() === "native",
      });
    }
  }

  private allocateSequence(): number {
    if (this.sent >= this.maxPassiveReplies()) {
      throw new Error("QQ passive reply limit was reached");
    }
    this.sent++;
    return this.sent;
  }

  private maxPassiveReplies(): number {
    switch (this.message.chatType) {
      case "direct":
        return DIRECT_MAX_PASSIVE_REPLIES;
      case "group":
        return GROUP_MAX_PASSIVE_REPLIES;
      case "channel":
        return CHANNEL_MAX_PASSIVE_REPLIES;
    }
  }
}

function qqMediaFileType(kind: ArtifactKind): QQMediaFileType {
  switch (kind) {
    case "image":
      return 1;
    case "video":
      return 2;
    case "voice":
      return 3;
  }
}

function capReplyChunks(
  chunks: string[],
  maximum: number,
  limit: number,
  split: (text: string, limit: number) => string[],
): string[] {
  if (chunks.length <= maximum) return chunks;
  if (maximum <= 0) return [];

  const capped = chunks.slice(0, maximum);
  const last = capped[maximum - 1]!;
  const contentLimit = Math.max(0, limit - TRUNCATION_NOTICE.length - 2);
  const safePrefix = split(last, contentLimit)[0] ?? "";
  capped[maximum - 1] =
    safePrefix
      ? `${safePrefix.trimEnd()}\n\n${TRUNCATION_NOTICE}`
      : TRUNCATION_NOTICE;
  return capped;
}

function streamSafeSource(source: string): string {
  let fence: { marker: string; length: number } | undefined;
  let fenceStart = -1;
  let inlineCode: { length: number; start: number } | undefined;
  let explicitMath: "\\]" | "\\)" | "$$" | undefined;
  let explicitMathStart = -1;
  let inlineDollarStart = -1;
  let trailingEscapeStart = -1;

  let trailingBackslashes = 0;
  for (
    let index = source.length - 1;
    index >= 0 && source[index] === "\\";
    index--
  ) {
    trailingBackslashes++;
  }
  if (trailingBackslashes % 2 === 1) {
    trailingEscapeStart = source.length - 1;
  }

  for (let index = 0; index < source.length; index++) {
    if (!inlineCode && (source[index] === "\n" || index === 0)) {
      const lineStart = index === 0 ? 0 : index + 1;
      const lineEnd = source.indexOf("\n", lineStart);
      const line = source.slice(
        lineStart,
        lineEnd === -1 ? source.length : lineEnd,
      );
      const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
      const marker = fenceMatch?.[1];
      if (marker) {
        if (!fence) {
          fence = { marker: marker[0]!, length: marker.length };
          fenceStart = lineStart;
        } else if (
          marker[0] === fence.marker &&
          marker.length >= fence.length &&
          !fenceMatch?.[2]?.trim()
        ) {
          fence = undefined;
          fenceStart = -1;
        }
      }
    }
    if (fence) continue;

    if (!explicitMath && source[index] === "`" && source[index - 1] !== "\\") {
      let length = 1;
      while (source[index + length] === "`") length++;
      if (!inlineCode) {
        inlineCode = { length, start: index };
      } else if (length === inlineCode.length) {
        inlineCode = undefined;
      }
      index += length - 1;
      continue;
    }
    if (inlineCode) continue;

    if (explicitMath) {
      if (
        (explicitMath === "$$" && source.startsWith("$$", index)) ||
        (explicitMath !== "$$" && source.startsWith(explicitMath, index))
      ) {
        index += explicitMath.length - 1;
        explicitMath = undefined;
        explicitMathStart = -1;
      }
      continue;
    }
    if (source.startsWith("\\[", index)) {
      explicitMath = "\\]";
      explicitMathStart = index;
      index++;
    } else if (source.startsWith("\\(", index)) {
      explicitMath = "\\)";
      explicitMathStart = index;
      index++;
    } else if (source.startsWith("$$", index)) {
      explicitMath = "$$";
      explicitMathStart = index;
      index++;
    } else if (
      source[index] === "$" &&
      source[index - 1] !== "\\" &&
      source[index - 1] !== "$" &&
      source[index + 1] !== "$"
    ) {
      if (inlineDollarStart === -1 && !/\s/.test(source[index + 1] ?? "")) {
        inlineDollarStart = index;
      } else if (
        inlineDollarStart !== -1 &&
        source[index + 1] !== undefined &&
        !/[$\d]/.test(source[index + 1]!)
      ) {
        inlineDollarStart = -1;
      }
    }
  }

  const protectedStart = [
    fenceStart,
    explicitMathStart,
    inlineDollarStart,
    inlineCode?.start ?? -1,
    trailingEscapeStart,
  ]
    .filter((position) => position >= 0)
    .sort((left, right) => left - right)[0];
  return protectedStart === undefined
    ? source
    : source.slice(0, protectedStart);
}

function countCharacters(text: string): number {
  return Array.from(text).length;
}

function takeCharacters(text: string, maximum: number): string {
  if (maximum <= 0) return "";
  return Array.from(text).slice(0, maximum).join("");
}

function truncateStreamText(
  desired: string,
  immutablePrefix: string,
  additionalCapacity: number,
  markdown: boolean,
): string {
  const maximum = countCharacters(immutablePrefix) + additionalCapacity;
  if (countCharacters(desired) <= maximum) return desired;
  if (maximum <= 0) return "";

  const codeUnitLimit = takeCharacters(desired, maximum).length;
  try {
    const candidate = (
      markdown
        ? splitMarkdown(desired, codeUnitLimit)
        : splitText(desired, codeUnitLimit)
    )[0];
    if (
      candidate?.startsWith(immutablePrefix) &&
      countCharacters(candidate) <= maximum &&
      streamSafeSource(candidate) === candidate
    ) {
      return candidate;
    }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }
  return immutablePrefix;
}

function streamTruncatedMarker(maximum: number): string {
  return STREAM_TRUNCATED_MARKERS.find(
    (marker) => countCharacters(marker) <= maximum,
  )!;
}

function streamCompletionMarker(maximum: number): string | undefined {
  return STREAM_COMPLETION_MARKERS.find(
    (marker) => countCharacters(marker) <= maximum,
  );
}
