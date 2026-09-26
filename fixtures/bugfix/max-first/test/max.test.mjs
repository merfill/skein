import assert from "node:assert/strict";
import { test } from "node:test";

import { maxOf } from "../src/max.mjs";

test("maxOf returns the largest value", () => {
  assert.equal(maxOf([3, 9, 2]), 9);
});
