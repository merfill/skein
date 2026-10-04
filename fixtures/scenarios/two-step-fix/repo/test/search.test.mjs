import assert from "node:assert/strict";
import { test } from "node:test";

import { parseDuration } from "../src/search.mjs";

test("hours, minutes and seconds separated by spaces", () => {
  assert.equal(parseDuration("1h 30m 15s"), 5415);
});

test("hours and minutes without spaces", () => {
  assert.equal(parseDuration("1h30m"), 5400);
});

test("seconds only", () => {
  assert.equal(parseDuration("90s"), 90);
});

test("minutes only", () => {
  assert.equal(parseDuration("2m"), 120);
});

test("empty string", () => {
  assert.equal(parseDuration(""), 0);
});
