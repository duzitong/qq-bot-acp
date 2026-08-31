import assert from "node:assert/strict";
import test from "node:test";
import type * as acp from "@agentclientprotocol/sdk";
import {
  formatSessionConfig,
  parseControlCommand,
} from "../src/bot/commands.js";

test("global configuration aliases parse key and JSON value", () => {
  assert.deepEqual(parseControlCommand('/c agent.args ["acp","--debug"]'), {
    kind: "config",
    operation: "set",
    key: "agent.args",
    value: '["acp","--debug"]',
  });
  assert.deepEqual(parseControlCommand("/config get agent.command"), {
    kind: "config",
    operation: "get",
    key: "agent.command",
  });
});

test("session configuration aliases remain conversation scoped", () => {
  assert.deepEqual(parseControlCommand("/sc reasoning_effort high"), {
    kind: "session-config",
    operation: "set",
    key: "reasoning_effort",
    value: "high",
  });
  assert.deepEqual(parseControlCommand("/session-config reset"), {
    kind: "session-config",
    operation: "reset",
  });
});

test("streaming diagnostic command is recognized exactly", () => {
  assert.deepEqual(parseControlCommand("/test-streaming"), {
    kind: "test-streaming",
  });
  assert.equal(parseControlCommand("/test-streaming now"), null);
});

test("session configuration display focuses on current values and valid choices", () => {
  const available: acp.SessionConfigOption[] = [
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "large",
      options: [
        { value: "small", name: "Small" },
        { value: "large", name: "Large" },
      ],
    },
    {
      id: "reasoning",
      name: "Reasoning",
      type: "select",
      currentValue: "high",
      options: [
        {
          group: "effort",
          name: "Effort",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
      ],
    },
    {
      id: "auto_approve",
      name: "Auto approve",
      type: "boolean",
      currentValue: false,
    },
  ];

  const output = formatSessionConfig({
    active: true,
    available,
  });

  assert.match(output, /\*\*Model\*\* \(id: `model`\)/);
  assert.match(output, /Current: Large \(`large`\)/);
  assert.match(output, /Options: Small \(`small`\) \| Large \(`large`\)/);
  assert.match(output, /Current: High \(`high`\)/);
  assert.match(output, /Current: `false`/);
  assert.match(output, /Options: `true` \| `false`/);
  assert.match(output, /Update: `\/session-config <configId> <value>` or `\/sc <configId> <value>`/);
  assert.doesNotMatch(output, /"active"|"available"|"persisted"/);
});

test("session configuration display explains how to start an inactive session", () => {
  const output = formatSessionConfig({
    active: false,
    available: [],
  });

  assert.match(output, /No active ACP session\. Send a normal message first\./);
  assert.match(output, /View: `\/session-config` or `\/sc`/);
});
