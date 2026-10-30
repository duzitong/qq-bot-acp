import assert from "node:assert/strict";
import test from "node:test";
import { InboundDeduplicator } from "../src/qq/dedup.js";

test("inbound deduplicator drops a repeated message ID within the window", () => {
  const dedup = new InboundDeduplicator(60_000, 100);
  assert.equal(dedup.isDuplicate("m1", 1_000), false);
  assert.equal(dedup.isDuplicate("m1", 2_000), true);
  assert.equal(dedup.isDuplicate("m2", 2_000), false);
});

test("inbound deduplicator forgets IDs after the window expires", () => {
  const dedup = new InboundDeduplicator(1_000, 100);
  assert.equal(dedup.isDuplicate("a", 0), false);
  assert.equal(dedup.isDuplicate("a", 500), true);
  assert.equal(dedup.isDuplicate("a", 1_500), false);
});

test("inbound deduplicator caps how many IDs it retains", () => {
  const dedup = new InboundDeduplicator(60_000, 2);
  assert.equal(dedup.isDuplicate("a", 0), false);
  assert.equal(dedup.isDuplicate("b", 1), false);
  assert.equal(dedup.isDuplicate("c", 2), false);
  assert.equal(dedup.isDuplicate("a", 3), false);
  assert.equal(dedup.isDuplicate("c", 4), true);
});

test("inbound deduplicator ignores empty IDs", () => {
  const dedup = new InboundDeduplicator();
  assert.equal(dedup.isDuplicate(""), false);
  assert.equal(dedup.isDuplicate(""), false);
});