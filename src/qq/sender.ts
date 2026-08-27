import type { BotConfig } from "../config/schema.js";
import type { QQSendTextInput } from "./api.js";
import {
  findStreamingSplit,
  renderMarkdownForQQ,
  splitText,
  trimBlockStart,
} from "./format.js";
import type { QQInboundMessage } from "./types.js";

const MAX_PASSIVE_REPLIES = 5;
const STREAM_REPLY_RESERVE = 1;
const STREAM_LENGTH_MARGIN = 64;
const TRUNCATION_NOTICE =
  "[Response truncated: QQ allows at most 5 replies to one message.]";

export interface QQMessageApi {
  sendText(input: QQSendTextInput): Promise<string | undefined>;
}

export interface QQReplyStream {
  write(text: string): Promise<void>;
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
  private finished = false;

  constructor(
    private readonly api: QQMessageApi,
    private readonly message: QQInboundMessage,
    private readonly output: BotConfig["output"],
  ) {}

  async write(text: string): Promise<void> {
    if (this.finished) throw new Error("Cannot write to a finished QQ reply");
    if (!text) return;
    this.buffer += text;
    if (this.output.streamResponses) await this.flushProgressive();
  }

  async finish(): Promise<void> {
    if (this.finished) return;

    const rendered = this.render(this.buffer);
    this.buffer = "";
    const chunks = capReplyChunks(
      splitText(rendered, this.output.textChunkLimit),
      MAX_PASSIVE_REPLIES - this.sent,
      this.output.textChunkLimit,
    );
    await this.sendChunks(chunks);
    this.finished = true;
  }

  private async flushProgressive(): Promise<void> {
    const progressiveLimit =
      MAX_PASSIVE_REPLIES - STREAM_REPLY_RESERVE;
    const maxLength = Math.max(
      this.output.streamMinChars,
      this.output.textChunkLimit - STREAM_LENGTH_MARGIN,
    );

    while (this.sent < progressiveLimit) {
      const splitAt = findStreamingSplit(
        this.buffer,
        this.output.streamMinChars,
        maxLength,
      );
      if (splitAt === undefined) return;

      const raw = this.buffer.slice(0, splitAt).trim();
      const chunks = splitText(this.render(raw), this.output.textChunkLimit);
      if (chunks.length > progressiveLimit - this.sent) return;

      this.buffer = trimBlockStart(this.buffer.slice(splitAt));
      await this.sendChunks(chunks);
    }
  }

  private render(text: string): string {
    return this.output.markdownMode === "plain"
      ? renderMarkdownForQQ(text)
      : text.trim();
  }

  private async sendChunks(chunks: string[]): Promise<void> {
    for (const text of chunks) {
      await this.api.sendText({
        chatType: this.message.chatType,
        targetId: this.message.targetId,
        text,
        replyToId: this.message.messageId,
        sequence: this.sent + 1,
        markdown:
          this.output.markdownMode === "native" &&
          this.message.chatType !== "channel",
      });
      this.sent++;
    }
  }
}

function capReplyChunks(
  chunks: string[],
  maximum: number,
  limit: number,
): string[] {
  if (chunks.length <= maximum) return chunks;
  if (maximum <= 0) return [];

  const capped = chunks.slice(0, maximum);
  const last = capped[maximum - 1]!;
  const contentLimit = Math.max(0, limit - TRUNCATION_NOTICE.length - 2);
  capped[maximum - 1] =
    `${last.slice(0, contentLimit).trimEnd()}\n\n${TRUNCATION_NOTICE}`;
  return capped;
}
