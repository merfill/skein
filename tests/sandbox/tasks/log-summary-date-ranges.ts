import type { SandboxTask } from "../task";

// terminal-bench `log-summary-date-ranges`: the image generates the log tree at build; the
// agent writes `/app/summary.csv`. Bare `/app` WORKDIR, verifier is stdlib-only.
export const logSummaryDateRanges: SandboxTask = {
  id: "log-summary-date-ranges",
  image: "alexgshaw/log-summary-date-ranges:20251031",
};
