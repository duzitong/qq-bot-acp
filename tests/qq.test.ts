import assert from "node:assert/strict";
import test from "node:test";
import { splitText } from "../src/qq/sender.js";

test("QQ replies split at natural boundaries", () => {
  assert.deepEqual(splitText("one two three", 7), ["one two", "three"]);
  assert.deepEqual(splitText("short", 10), ["short"]);
});
