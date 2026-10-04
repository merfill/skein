import assert from "node:assert/strict";
import { test } from "node:test";

import { summarize } from "../src/report.mjs";

test("summarize formats scores", () => {
  assert.deepEqual(summarize([{ name: "a", score: 1 }]), ["a: 1.00"]);
});
