import assert from "node:assert/strict";
import { test } from "node:test";

import { scale } from "../src/scale.mjs";

test("scale multiplies", () => {
  assert.equal(scale(5), 10);
  assert.equal(scale(0), 0);
});
