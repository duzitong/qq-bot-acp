import fs from "node:fs/promises";
import type * as acp from "@agentclientprotocol/sdk";

export interface TurnCallbacks {
  onText: (text: string) => Promise<void>;
  onThought?: (text: string) => Promise<void>;
  onComplete?: () => Promise<void>;
}

export class QQBotAcpClient implements acp.Client {
  private callbacks: TurnCallbacks = { onText: async () => {} };
  private taskChain = Promise.resolve();
  private showThoughts = false;
  private callbackError: unknown;

  beginTurn(callbacks: TurnCallbacks, showThoughts: boolean): Promise<void> {
    return this.enqueue(async () => {
      this.callbacks = callbacks;
      this.showThoughts = showThoughts;
      this.callbackError = undefined;
    });
  }

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const selected =
      params.options.find((option) => option.kind === "allow_always") ??
      params.options.find((option) => option.kind === "allow_once") ??
      params.options[0];
    return selected
      ? { outcome: { outcome: "selected", optionId: selected.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  sessionUpdate(params: acp.SessionNotification): Promise<void> {
    return this.enqueue(async () => {
      const update = params.update;
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text"
      ) {
        await this.invoke(this.callbacks.onText, update.content.text);
        return;
      }
      if (
        update.sessionUpdate === "agent_thought_chunk" &&
        update.content.type === "text" &&
        this.showThoughts
      ) {
        await this.invoke(this.callbacks.onThought, update.content.text);
      }
    });
  }

  async flush(): Promise<void> {
    await this.enqueue(async () => {
      if (this.callbackError !== undefined) throw this.callbackError;
      await this.callbacks.onComplete?.();
    });
  }

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const content = await fs.readFile(params.path, "utf8");
    const lines = content.split(/\r?\n/);
    const start = params.line ? Math.max(0, params.line - 1) : 0;
    const selected =
      params.limit == null ? lines.slice(start) : lines.slice(start, start + params.limit);
    return { content: selected.join("\n") };
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    await fs.writeFile(params.path, params.content, "utf8");
    return {};
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.taskChain.then(task);
    this.taskChain = run.catch(() => {});
    return run;
  }

  private async invoke(
    callback: ((text: string) => Promise<void>) | undefined,
    text: string,
  ): Promise<void> {
    if (!callback || !text || this.callbackError !== undefined) return;
    try {
      await callback(text);
    } catch (error) {
      this.callbackError = error;
      throw error;
    }
  }
}
