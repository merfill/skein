import assert from "node:assert/strict";
import { test } from "node:test";

import { total, subtotal, lineTotal } from "../src/ledger.mjs";

const report = [
  { label: "widget", price: "$10.00", qty: 2 },
  { label: "gadget", price: "$5.50", qty: 4 },
];

test("line totals round to cents", () => {
  assert.equal(lineTotal(report[1]), 22);
});

test("subtotal adds the lines", () => {
  assert.equal(subtotal(report), 42);
});

test("total adds tax on top of the subtotal", () => {
  assert.equal(total(report, 0.2), 50.4);
});

test("total defaults to 20% tax", () => {
  assert.equal(total(report), 50.4);
});
