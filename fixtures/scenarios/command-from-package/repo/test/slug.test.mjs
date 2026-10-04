import assert from "node:assert/strict";
import { test } from "node:test";

import { slugify } from "../src/slug.mjs";

test("lowercases and hyphenates spaces", () => {
  assert.equal(slugify("Hello World"), "hello-world");
});

test("strips punctuation", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
});
