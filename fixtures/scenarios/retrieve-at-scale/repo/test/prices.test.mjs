import assert from "node:assert/strict";
import { test } from "node:test";

import { priceAt } from "../src/prices.mjs";

const STEP = 3;
const OFFSET = 7;
const ROWS = 900;

test("every price matches the published table", () => {
  const lines = [];
  for (let i = 0; i < ROWS; i += 1) {
    lines.push(`row ${i}: expected=${i * STEP + OFFSET} actual=${priceAt(i)}`);
  }
  console.log(lines.join("\n"));
  for (let i = 0; i < ROWS; i += 1) {
    assert.equal(priceAt(i), i * STEP + OFFSET, `mismatch at row ${i}`);
  }
});
