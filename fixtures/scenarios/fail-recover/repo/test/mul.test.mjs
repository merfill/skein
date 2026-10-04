import assert from "node:assert/strict";
import { test } from "node:test";

import { mul } from "../src/mul.mjs";

test("mul multiplies", () => {
  assert.equal(mul(3, 4), 12);
});
