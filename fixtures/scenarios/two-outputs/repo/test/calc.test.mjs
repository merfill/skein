import assert from "node:assert/strict";
import { test } from "node:test";

import { factorial } from "../src/calc.mjs";

test("factorial(4) is 24", () => {
  assert.equal(factorial(4), 24);
});
