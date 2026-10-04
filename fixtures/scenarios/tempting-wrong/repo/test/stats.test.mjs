import assert from "node:assert/strict";
import { test } from "node:test";

import { median } from "../src/stats.mjs";

test("median of an odd-length unsorted list", () => {
  assert.equal(median([3, 1, 2]), 2);
});

test("median of an even-length unsorted list", () => {
  assert.equal(median([9, 7, 1, 3]), 5);
});

test("median of a single value", () => {
  assert.equal(median([5]), 5);
});

test("median of equal values", () => {
  assert.equal(median([2, 2, 2, 2]), 2);
});
