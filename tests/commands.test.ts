import assert from "node:assert/strict";
import test from "node:test";
import { parseControlCommand } from "../src/bot/commands.js";

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
