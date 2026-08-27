import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ArtifactBroker, type ArtifactSession } from "../src/artifacts/broker.js";
import {
  MAX_ARTIFACT_BYTES,
  prepareArtifact,
  type PreparedArtifact,
} from "../src/artifacts/file.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("artifact files are contained, typed, and size-limited", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "qq-artifacts-files-"));
  const root = path.join(parent, "workspace");
  const outside = path.join(parent, "outside.png");
  await fs.mkdir(root);
  try {
    await fs.writeFile(path.join(root, "image.png"), PNG);
    await fs.writeFile(path.join(root, "image.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    await fs.writeFile(path.join(root, "notes.txt"), "not an image");
    await fs.writeFile(outside, PNG);
    await fs.symlink(outside, path.join(root, "escaped.png"));
    const oversized = await fs.open(path.join(root, "oversized.png"), "w");
    await oversized.truncate(MAX_ARTIFACT_BYTES + 1);
    await oversized.close();

    const png = await prepareArtifact(root, "image.png");
    assert.equal(png.mimeType, "image/png");
    assert.equal(png.fileName, "image.png");
    assert.deepEqual(png.data, PNG);

    const jpeg = await prepareArtifact(root, "image.jpg");
    assert.equal(jpeg.mimeType, "image/jpeg");
    await assert.rejects(
      prepareArtifact(root, outside),
      /inside the agent working directory/,
    );
    await assert.rejects(
      prepareArtifact(root, "escaped.png"),
      /inside the agent working directory/,
    );
    await assert.rejects(prepareArtifact(root, "notes.txt"), /Unsupported artifact type/);
    await assert.rejects(prepareArtifact(root, "oversized.png"), /20 MiB upload limit/);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("HTTP MCP exposes explicit, token-isolated artifact delivery", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "qq-artifacts-mcp-"));
  const firstRoot = path.join(parent, "first");
  const secondRoot = path.join(parent, "second");
  await fs.mkdir(firstRoot);
  await fs.mkdir(secondRoot);
  await fs.writeFile(path.join(firstRoot, "image.png"), PNG);
  await fs.writeFile(
    path.join(secondRoot, "image.png"),
    Buffer.concat([PNG, Buffer.from("second")]),
  );

  const logs: string[] = [];
  const broker = new ArtifactBroker((message) => logs.push(message));
  await broker.start();
  const firstSession = broker.createSession(firstRoot);
  const secondSession = broker.createSession(secondRoot);
  const firstClient = await connect(firstSession);
  const secondClient = await connect(secondSession);
  const firstDeliveries: PreparedArtifact[] = [];
  const secondDeliveries: PreparedArtifact[] = [];
  try {
    const tools = await firstClient.client.listTools();
    assert.deepEqual(tools.tools.map(({ name }) => name), ["send_artifact"]);
    assert.deepEqual(tools.tools[0]?.inputSchema.required, ["path"]);

    const inactive = await firstClient.client.callTool({
      name: "send_artifact",
      arguments: { path: "image.png" },
    });
    assert.equal(inactive.isError, true);
    assert.match(textResult(inactive), /only during an active QQ turn/);

    firstSession.beginTurn(async (artifact, caption) => {
      firstDeliveries.push(artifact);
      assert.equal(caption, "First image");
      return { alreadySent: false };
    });
    secondSession.beginTurn(async (artifact) => {
      secondDeliveries.push(artifact);
      return { alreadySent: false };
    });

    const sent = await firstClient.client.callTool({
      name: "send_artifact",
      arguments: { path: "image.png", caption: "First image" },
    });
    assert.equal(sent.isError, undefined);
    assert.equal(textResult(sent), "Sent image.png to QQ.");
    assert.equal(firstDeliveries.length, 1);
    assert.equal(secondDeliveries.length, 0);

    const escaped = await firstClient.client.callTool({
      name: "send_artifact",
      arguments: { path: "../second/image.png" },
    });
    assert.equal(escaped.isError, true);
    assert.match(textResult(escaped), /inside the agent working directory/);

    await secondClient.client.callTool({
      name: "send_artifact",
      arguments: { path: "image.png" },
    });
    assert.equal(firstDeliveries.length, 1);
    assert.equal(secondDeliveries.length, 1);
    assert.notEqual(firstDeliveries[0]?.digest, secondDeliveries[0]?.digest);

    const config = httpConfig(firstSession);
    const unauthorized = await fetch(config.url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${"0".repeat(64)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(logs, []);
  } finally {
    firstSession.endTurn();
    secondSession.endTurn();
    await Promise.all([
      firstClient.transport.close(),
      secondClient.transport.close(),
    ]);
    firstSession.dispose();
    secondSession.dispose();
    await broker.stop();
    await fs.rm(parent, { recursive: true, force: true });
  }
});

async function connect(session: ArtifactSession) {
  const config = httpConfig(session);
  const headers = Object.fromEntries(
    config.headers.map(({ name, value }) => [name, value]),
  );
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers },
  });
  const client = new Client({
    name: "qq-bot-acp-test",
    version: "0.1.0",
  });
  await client.connect(transport);
  return { client, transport };
}

function httpConfig(session: ArtifactSession) {
  const config = session.mcpServer;
  assert.equal(config.type, "http");
  if (config.type !== "http") throw new Error("Expected HTTP MCP configuration");
  return config;
}

function textResult(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = "content" in result ? result.content[0] : undefined;
  assert.equal(content?.type, "text");
  return content?.type === "text" ? content.text : "";
}
