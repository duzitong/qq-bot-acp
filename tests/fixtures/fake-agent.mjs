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
        },
      },
    });
    return;
  }
  if (request.method === "session/new") {
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
          content: { type: "text", text: `echo:${text}` },
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
