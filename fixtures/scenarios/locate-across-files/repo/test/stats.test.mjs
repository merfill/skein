import assert from "node:assert/strict";
import { test } from "node:test";

import { mean } from "../src/index.mjs";

test("mean of 1,2,3 is 2", () => {
  assert.equal(mean([1, 2, 3]), 2);
});
