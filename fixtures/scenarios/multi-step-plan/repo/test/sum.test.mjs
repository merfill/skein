import assert from "node:assert/strict";
import { test } from "node:test";

import { sumTo } from "../src/sum.mjs";

test("sumTo(5) is 15", () => {
  assert.equal(sumTo(5), 15);
});
