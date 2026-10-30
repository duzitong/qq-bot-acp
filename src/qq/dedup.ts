const DEFAULT_WINDOW_MS = 10 * 60_000;
const DEFAULT_MAX_ENTRIES = 500;

/**
 * Tracks recently handled inbound message IDs so a message that the QQ gateway
 * delivers more than once (for example after a reconnect or resume) is only
 * answered once. Answering the same message twice consumes the same passive
 * reply slot again and makes QQ reject the second one as a duplicate
 * (`40054005 消息被去重`).
 */
export class InboundDeduplicator {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly windowMs = DEFAULT_WINDOW_MS,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
  ) {}

  /** Returns true when this message ID was already handled within the window. */
  isDuplicate(messageId: string, now = Date.now()): boolean {
    if (!messageId) return false;
    this.prune(now);
    if (this.seen.has(messageId)) return true;
    this.seen.set(messageId, now);
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return false;
  }

  private prune(now: number): void {
    for (const [id, seenAt] of this.seen) {
      if (now - seenAt <= this.windowMs) break;
      this.seen.delete(id);
    }
  }
}