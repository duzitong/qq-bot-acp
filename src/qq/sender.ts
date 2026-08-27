import type {
  ArtifactKind,
  PreparedArtifact,
} from "../artifacts/file.js";
import type { BotConfig } from "../config/schema.js";
import type {
  QQMediaFileType,
  QQSendMediaInput,
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

const MAX_PASSIVE_REPLIES = 5;
const PROGRESSIVE_REPLY_LIMIT = 2;
const FINAL_REPLY_RESERVE = 1;
const MAX_ARTIFACTS_PER_TURN = 2;
const STREAM_LENGTH_MARGIN = 64;
const TRUNCATION_NOTICE =
  "Response truncated: QQ allows at most 5 replies to one message.";

type EffectiveMarkdownMode = BotConfig["output"]["markdownMode"];

export interface QQMessageApi {
  sendText(input: QQSendTextInput): Promise<string | undefined>;
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
    if (!text) return;
    this.buffer += text;
    if (this.output.streamResponses) await this.flushProgressive();
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
    if (this.sent >= MAX_PASSIVE_REPLIES - FINAL_REPLY_RESERVE) {
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
      sequence: this.sent + 1,
      caption: caption ? renderMarkdownForQQ(caption) : undefined,
    });
    this.sent++;
    this.artifactsSent++;
    this.artifactDigests.add(artifact.digest);
    return { alreadySent: false };
  }

  private async finishNow(): Promise<void> {
    if (this.finished) return;

    const rendered = this.render(this.buffer);
    this.buffer = "";
    const chunks = capReplyChunks(
      this.split(rendered),
      MAX_PASSIVE_REPLIES - this.sent,
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
        sequence: this.sent + 1,
        markdown: this.effectiveMarkdownMode() === "native",
      });
      this.sent++;
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
