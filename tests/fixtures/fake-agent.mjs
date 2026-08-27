import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: request.params.protocolVersion,
        agentCapabilities: {
          loadSession: false,
          mcpCapabilities: {
            http: true,
          },
        },
      },
    });
    return;
  }
  if (request.method === "session/new") {
    const artifacts = request.params.mcpServers?.find(
      (server) => server.name === "qq-artifacts",
    );
    if (
      artifacts?.type !== "http" ||
      !artifacts.url?.startsWith("http://127.0.0.1:") ||
      !artifacts.headers?.some(
        (header) =>
          header.name.toLowerCase() === "authorization" &&
          /^Bearer [0-9a-f]{64}$/.test(header.value),
      )
    ) {
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32602,
          message: "qq-artifacts HTTP MCP server was not injected",
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        sessionId: "fake-session",
        configOptions: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "small",
            options: [
              { value: "small", name: "Small" },
              { value: "large", name: "Large" }
            ]
          }
        ],
      },
    });
    return;
  }
  if (request.method === "session/set_config_option") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        configOptions: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: request.params.value,
            options: [
              { value: "small", name: "Small" },
              { value: "large", name: "Large" }
            ]
          }
        ],
      },
    });
    return;
  }
  if (request.method === "session/prompt") {
    const text = request.params.prompt
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: request.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "echo:" },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: request.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: { stopReason: "end_turn" },
    });
  }
});
