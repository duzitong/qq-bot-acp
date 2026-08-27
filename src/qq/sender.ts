import type { BotConfig } from "../config/schema.js";
import { QQApi } from "./api.js";
import type { QQInboundMessage } from "./types.js";

export class QQSender {
  constructor(
    private readonly api: QQApi,
    private readonly getConfig: () => BotConfig,
  ) {}

  async reply(message: QQInboundMessage, text: string): Promise<void> {
    const chunks = splitText(text, this.getConfig().output.textChunkLimit);
    for (let index = 0; index < chunks.length; index++) {
      await this.api.sendText({
        chatType: message.chatType,
        targetId: message.targetId,
        text: chunks[index]!,
        replyToId: message.messageId,
        sequence: index + 1,
      });
    }
  }
}

export function splitText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < limit / 2) splitAt = remaining.lastIndexOf(" ", limit);
    if (splitAt < limit / 2) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
