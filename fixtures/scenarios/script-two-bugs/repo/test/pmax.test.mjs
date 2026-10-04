import assert from "node:assert/strict";
import { test } from "node:test";

import { pmax } from "../src/pmax.mjs";

test("max of positive numbers", () => {
  assert.equal(pmax([1, 5, 3]), 5);
});

test("max of negative numbers", () => {
  assert.equal(pmax([-5, -1, -3]), -1);
});
