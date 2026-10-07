import assert from "node:assert/strict";
import { test } from "node:test";

import { tokenize } from "../src/tokenize.mjs";

test("splits lowercase words and drops one-letter tokens", () => {
  assert.deepEqual(tokenize("The cat sat on a mat"), ["the", "cat", "sat", "on", "mat"]);
});

test("handles punctuation and repeats", () => {
  assert.deepEqual(tokenize("Go, go! GO; go"), ["go", "go", "go", "go"]);
});
