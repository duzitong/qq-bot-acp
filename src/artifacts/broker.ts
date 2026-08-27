import crypto from "node:crypto";
import http from "node:http";
import type * as acp from "@agentclientprotocol/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { prepareArtifact, type PreparedArtifact } from "./file.js";

const REQUEST_PATH = "/mcp";
const MAX_REQUEST_BYTES = 16 * 1024;

export interface ArtifactDeliveryResult {
  alreadySent: boolean;
}

export type ArtifactDeliveryHandler = (
  artifact: PreparedArtifact,
  caption?: string,
) => Promise<ArtifactDeliveryResult>;

export interface ArtifactSession {
  mcpServer: acp.McpServer;
  beginTurn(handler: ArtifactDeliveryHandler): void;
  endTurn(): void;
  dispose(): void;
}

interface SessionRegistration {
  cwd: string;
  handler?: ArtifactDeliveryHandler;
}

export class ArtifactBroker {
  private readonly sessions = new Map<string, SessionRegistration>();
  private server?: http.Server;
  private endpoint?: string;

  constructor(private readonly log: (message: string) => void) {}

  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((request, response) => {
      void this.handleRequest(request, response).catch((error) => {
        this.log(`Artifact MCP request failed: ${errorMessage(error)}`);
        sendMcpError(response, 500, -32603, "Internal server error");
      });
    });
    server.requestTimeout = 120_000;
    server.headersTimeout = 10_000;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Artifact MCP server did not receive a TCP address");
    }
    this.server = server;
    this.endpoint = `http://127.0.0.1:${address.port}${REQUEST_PATH}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.endpoint = undefined;
    this.sessions.clear();
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  createSession(cwd: string): ArtifactSession {
    if (!this.endpoint) throw new Error("Artifact MCP server is not running");
    const token = crypto.randomBytes(32).toString("hex");
    const registration: SessionRegistration = { cwd };
    this.sessions.set(token, registration);
    let disposed = false;

    return {
      mcpServer: {
        type: "http",
        name: "qq-artifacts",
        url: this.endpoint,
        headers: [{
          name: "authorization",
          value: `Bearer ${token}`,
        }],
      },
      beginTurn: (handler) => {
        if (disposed) throw new Error("Artifact session is closed");
        if (registration.handler) {
          throw new Error("Artifact session already has an active turn");
        }
        registration.handler = handler;
      },
      endTurn: () => {
        registration.handler = undefined;
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        registration.handler = undefined;
        this.sessions.delete(token);
      },
    };
  }

  private async handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    if (request.url !== REQUEST_PATH) {
      sendMcpError(response, 404, -32000, "Not found");
      return;
    }
    if (!isRequestSizeAllowed(request)) {
      sendMcpError(response, 413, -32000, "Request too large");
      return;
    }

    const token = bearerToken(request.headers.authorization);
    const registration = token ? this.sessions.get(token) : undefined;
    if (!registration) {
      sendMcpError(response, 401, -32001, "Invalid artifact session");
      return;
    }

    const mcp = createArtifactMcpServer(registration);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await Promise.allSettled([transport.close(), mcp.close()]);
    };
    response.once("close", () => void close());

    await mcp.connect(transport);
    try {
      await transport.handleRequest(request, response);
    } catch (error) {
      await close();
      throw error;
    }
  }
}

function createArtifactMcpServer(
  registration: SessionRegistration,
): McpServer {
  const server = new McpServer({
    name: "qq-bot-acp-artifacts",
    version: "0.1.0",
  });
  server.registerTool(
    "send_artifact",
    {
      title: "Send artifact to QQ",
      description:
        "Send a PNG or JPEG file to the current QQ conversation. " +
        "Call this only when the user should receive the artifact. " +
        "The path may be absolute or relative to the session working directory.",
      inputSchema: {
        path: z.string().trim().min(1).max(4096),
        caption: z.string().trim().min(1).max(500).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ path, caption }) => {
      const handler = registration.handler;
      if (!handler) {
        return toolError(
          "send_artifact is available only during an active QQ turn",
        );
      }
      try {
        const artifact = await prepareArtifact(registration.cwd, path);
        const result = await handler(artifact, caption);
        return {
          content: [{
            type: "text" as const,
            text: result.alreadySent
              ? `${artifact.fileName} was already sent in this turn.`
              : `Sent ${artifact.fileName} to QQ.`,
          }],
        };
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  );
  return server;
}

function isRequestSizeAllowed(request: http.IncomingMessage): boolean {
  const raw = request.headers["content-length"];
  if (!raw) return true;
  const size = Number(raw);
  return Number.isInteger(size) && size >= 0 && size <= MAX_REQUEST_BYTES;
}

function bearerToken(value: string | undefined): string | undefined {
  const match = value?.match(/^Bearer ([0-9a-f]{64})$/);
  return match?.[1];
}

function toolError(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Unable to send artifact: ${message}` }],
  };
}

function sendMcpError(
  response: http.ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  if (response.headersSent || response.destroyed) return;
  const data = JSON.stringify({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
  });
  response.end(data);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
