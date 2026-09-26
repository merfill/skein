import assert from "node:assert/strict";
import { test } from "node:test";

import { greet } from "../src/greet.mjs";

test("greet adds an exclamation mark", () => {
  assert.equal(greet("Ada"), "Hello, Ada!");
});
