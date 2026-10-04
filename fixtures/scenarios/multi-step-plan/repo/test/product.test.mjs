import assert from "node:assert/strict";
import { test } from "node:test";

import { product } from "../src/product.mjs";

test("product(4) is 24", () => {
  assert.equal(product(4), 24);
});
