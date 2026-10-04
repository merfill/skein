import assert from "node:assert/strict";
import { test } from "node:test";

import { add, mul } from "../src/index.mjs";

test("add", () => {
  assert.equal(add(2, 3), 5);
});

test("mul", () => {
  assert.equal(mul(2, 3), 6);
});
