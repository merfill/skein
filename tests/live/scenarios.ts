import type { Branch, ScenarioConstraint } from "./harness";

// Live scenarios: each targets one branch of the loop (see docs/testing_ru.md §3).
// Soft `uses` are reported but do not fail; hard fields are asserted.

export interface Scenario {
  name: string;
  maxTurns?: number;
  constraints?: ScenarioConstraint[];
  check?: string;
  expect: {
    solved?: boolean;
    addressed?: boolean;
    stopReason?: string;
    maxRepeats?: number;
    noMutation?: boolean;
    unchanged?: string[];
    uses?: Branch[];
    // Run-command shape: for each rule, the number of executed `run` commands matching
    // `match` (a regex source) must be within [min, max]. Used to test a strategy that
    // shows up as a command (e.g. diffing a reference) or as a command that is avoided
    // (e.g. repeated `git` when the workspace has no history).
    commands?: { match: string; min?: number; max?: number }[];
  };
}

export const scenarios: Scenario[] = [
  {
    name: "locate-across-files",
    expect: { solved: true,     maxRepeats: 5, uses: ["read", "grep", "list"] },
  },
  {
    name: "reproduce-then-read",
    expect: { solved: true, uses: ["run", "recall"] },
  },
  {
    name: "stale-base",
    expect: { solved: true,     maxRepeats: 5, uses: ["edit", "run"] },
  },
  {
    name: "revise-hypothesis",
    expect: { solved: true, uses: ["create_goal", "revise"] },
  },
  {
    name: "two-outputs",
    expect: { solved: true, maxRepeats: 5 },
  },
  {
    name: "constraint-honored",
    expect: { solved: true,     maxRepeats: 5, unchanged: ["test/", "config.mjs"] },
  },
  {
    name: "no-mutation-answer",
    expect: { solved: false, noMutation: true, unchanged: [""], uses: ["create_goal"] },
  },
  {
    name: "multi-step-plan",
    expect: { solved: true,     maxRepeats: 5, uses: ["create_goal"] },
  },
  {
    name: "fail-recover",
    expect: { solved: true, addressed: true, uses: ["run"] },
  },
  {
    name: "tempting-wrong",
    expect: { solved: true, maxRepeats: 5, uses: ["edit", "run"] },
  },
  {
    name: "two-step-fix",
    expect: { solved: true, maxRepeats: 5, uses: ["edit", "run"] },
  },
  {
    name: "script-two-bugs",
    expect: { solved: true, addressed: true, maxRepeats: 5, uses: ["edit", "run"] },
  },
  {
    name: "make-command",
    expect: { solved: true, addressed: true, maxRepeats: 5, uses: ["edit", "run"] },
  },
  {
    name: "verbatim-flag",
    expect: { solved: true, addressed: true, maxRepeats: 5, uses: ["edit", "run"] },
  },
  {
    name: "command-from-package",
    expect: { solved: true, addressed: true, maxRepeats: 5, uses: ["run"] },
  },
  {
    name: "retrieve-at-scale",
    expect: { solved: true,     maxRepeats: 5, uses: ["recall"] },
  },
  {
    // A canonical copy sits in the workspace: if the model reaches for it, the localization
    // is a diff against it, not a line-by-line read. (No longer prompted — B9 removed.)
    name: "reference-diff",
    expect: { solved: true, uses: ["run"], commands: [{ match: "diff", min: 1 }] },
  },
  {
    // No `.git`; the request tempts a history probe. The run must fall back to files and
    // behavior rather than retrying/probing history. (No longer prompted — B8 removed.)
    name: "no-vcs",
    expect: { solved: true, maxRepeats: 5, commands: [{ match: "\\bgit\\b", max: 2 }] },
  },
];
