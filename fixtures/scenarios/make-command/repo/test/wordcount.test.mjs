import assert from "node:assert/strict";
import { test } from "node:test";

import { wordCount } from "../src/wordcount.mjs";

test("counts words separated by single spaces", () => {
  assert.equal(wordCount("hello world"), 2);
});

test("ignores surrounding and repeated whitespace", () => {
  assert.equal(wordCount("  spaced   out "), 2);
});

test("empty string has no words", () => {
  assert.equal(wordCount(""), 0);
});
