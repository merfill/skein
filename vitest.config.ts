import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Cap concurrent `it.concurrent` tests (the live scenarios run in parallel): the
    // provider handles ~5 in flight, matching the Harbor comparison (docs/testing_ru.md).
    maxConcurrency: 5,
  },
});
