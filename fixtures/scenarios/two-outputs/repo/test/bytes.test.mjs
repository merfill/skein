import assert from "node:assert/strict";
import { test } from "node:test";

import { toKB } from "../src/bytes.mjs";

test("2048 bytes is 2 KB", () => {
  assert.equal(toKB(2048), 2);
});
