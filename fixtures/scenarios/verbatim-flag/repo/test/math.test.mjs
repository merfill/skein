import assert from "node:assert/strict";
import { test } from "node:test";

import { clamp } from "../src/math.mjs";

test("clamps above the upper bound", () => {
  assert.equal(clamp(10, 0, 5), 5);
});

test("clamps below the lower bound", () => {
  assert.equal(clamp(-3, 0, 5), 0);
});

test("keeps a value inside the range", () => {
  assert.equal(clamp(3, 0, 5), 3);
});
