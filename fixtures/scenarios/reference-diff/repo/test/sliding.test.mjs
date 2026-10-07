import assert from "node:assert/strict";
import { test } from "node:test";

import { maxWindowSum } from "../src/sliding.mjs";

test("max sum of two consecutive elements", () => {
  assert.equal(maxWindowSum([1, 2, 3, 4, 5], 2), 9);
});

test("best window is not at the end", () => {
  assert.equal(maxWindowSum([5, 1, 1, 5], 2), 6);
});

test("window equals the whole array", () => {
  assert.equal(maxWindowSum([1, 2, 3], 3), 6);
});

test("empty or impossible window", () => {
  assert.equal(maxWindowSum([1, 2, 3], 0), 0);
  assert.equal(maxWindowSum([1, 2, 3], 5), 0);
});
