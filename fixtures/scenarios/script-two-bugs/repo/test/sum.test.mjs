import assert from "node:assert/strict";
import { test } from "node:test";

import { sum } from "../src/sum.mjs";

test("sums positive numbers", () => {
  assert.equal(sum(2, 3), 5);
});

test("sums with a negative addend", () => {
  assert.equal(sum(5, -2), 3);
});
