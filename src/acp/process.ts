import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { BotConfig } from "../config/schema.js";
import { QQBotAcpClient } from "./client.js";

export interface AgentConnection {
  process: ChildProcess;
  connection: acp.ClientSideConnection;
  client: QQBotAcpClient;
  sessionId: string;
  configOptions: acp.SessionConfigOption[];
  loaded: boolean;
}

export async function startAgent(
  config: BotConfig["agent"],
  options?: {
    persistedSessionId?: string;
    resume?: BotConfig["sessions"]["resume"];
    log?: (message: string) => void;
  },
): Promise<AgentConnection> {
  const client = new QQBotAcpClient();
  const useShell =
    globalThis.process.platform === "win32" &&
    (path.extname(config.command) === "" || /\.(?:cmd|bat)$/i.test(config.command));
  const command =
    useShell && /\s/.test(config.command) ? `"${config.command}"` : config.command;
  const process = spawn(command, config.args, {
    cwd: config.cwd,
    env: { ...globalThis.process.env, ...config.env },
    stdio: ["pipe", "pipe", "inherit"],
    shell: useShell,
    windowsHide: true,
  });

  try {
    if (!process.stdin || !process.stdout) {
      throw new Error("ACP agent did not expose stdin/stdout");
    }
    const stream = acp.ndJsonStream(
      Writable.toWeb(process.stdin),
      Readable.toWeb(process.stdout) as ReadableStream<Uint8Array>,
    );
    const connection = new acp.ClientSideConnection(() => client, stream);
    const initialized = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: {
        name: "qq-bot-acp",
        title: "QQ Bot ACP",
        version: "0.1.0",
      },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });

    const resume = options?.resume ?? "off";
    if (options?.persistedSessionId && resume !== "off") {
      if (initialized.agentCapabilities?.loadSession !== true) {
        if (resume === "required") {
          throw new Error("The configured agent does not support ACP session/load");
        }
      } else {
        try {
          const loaded = await connection.loadSession({
            cwd: config.cwd,
            mcpServers: [],
            sessionId: options.persistedSessionId,
          });
          return {
            process,
            connection,
            client,
            sessionId: options.persistedSessionId,
            configOptions: loaded.configOptions ?? [],
            loaded: true,
          };
        } catch (error) {
          if (resume === "required" || !isResourceNotFound(error)) throw error;
          options.log?.("Persisted ACP session was not found; creating a new session");
        }
      }
    }

    const created = await connection.newSession({
      cwd: config.cwd,
      mcpServers: [],
    });
    return {
      process,
      connection,
      client,
      sessionId: created.sessionId,
      configOptions: created.configOptions ?? [],
      loaded: false,
    };
  } catch (error) {
    await stopAgentProcess(process);
    throw error;
  }
}

export async function smokeTestAgent(config: BotConfig["agent"]): Promise<void> {
  const agent = await startAgent(config);
  await stopAgentProcess(agent.process);
}

export async function stopAgentProcess(process: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    process.once("exit", () => resolve());
    process.once("close", () => resolve());
  });
  process.kill("SIGTERM");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    exited,
    new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL");
        resolve();
      }, timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
}

function isResourceNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === -32002
  );
}
