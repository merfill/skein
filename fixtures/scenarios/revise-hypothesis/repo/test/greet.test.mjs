import assert from "node:assert/strict";
import { test } from "node:test";

import { greet } from "../src/greet.mjs";

test("greets with a bang", () => {
  assert.equal(greet("Ada"), "Hello, Ada!");
});

test("empty name greets the world", () => {
  assert.equal(greet(""), "Hello, world!");
});
