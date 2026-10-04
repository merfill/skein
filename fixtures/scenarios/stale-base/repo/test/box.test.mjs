import assert from "node:assert/strict";
import { test } from "node:test";

import { area } from "../src/box.mjs";

test("area of 3x4 is 12", () => {
  assert.equal(area(3, 4), 12);
});
