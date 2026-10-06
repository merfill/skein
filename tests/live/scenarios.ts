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
  };
}

export const scenarios: Scenario[] = [
  {
    name: "locate-across-files",
    expect: { solved: true,     maxRepeats: 5, uses: ["read", "grep", "list"] },
  },
  {
    name: "reproduce-then-read",
    expect: { solved: true, uses: ["run", "query"] },
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
    expect: { solved: false, noMutation: true, unchanged: [""], uses: ["complete"] },
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
    expect: { solved: true,     maxRepeats: 5, uses: ["query"] },
  },
];
