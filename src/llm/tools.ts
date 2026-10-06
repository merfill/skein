import { z } from "zod";

import {
  actionSchema,
  doneWhenSchema,
  planItemSchema,
  type Action,
  type Proposal,
} from "./schemas";

// Structured output via native tool calls (docs/testing_ru.md §8.1). The provider does
// not hold tool calling well when the schema is ONE deeply nested discriminated union
// (the operator came back flat). So every operation is its own FLAT function tool, which
// the model calls by name; `toProposal` maps the call back into the IR `Action`. The
// parameters are generated from the zod schemas below, so types/enums/oneOf cannot drift.
export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// Model-facing parameters. These mirror the IR operators but expose only what the model
// needs (e.g. `query` without the tree selectors, `list` without `exclude`/`limit`); the
// engine schema (`applySchema`) still accepts the full form.
const createGoalParams = z.object({
  what: z.string(),
  why: z.string().optional(),
  done_when: doneWhenSchema,
  plan: z.array(planItemSchema).nonempty().optional(),
  revises: z.array(z.string()).optional(),
});
const completeParams = z.object({
  goal: z.string().optional(),
  note: z.string().optional(),
  under: z.array(z.string()).optional(),
});
const queryParams = z.object({
  id: z.string().optional(),
  start: z.number().int().positive().optional(),
  end: z.number().int().positive().optional(),
});
const readParams = z.object({
  path: z.string(),
  start: z.number().int().optional(),
  end: z.number().int().optional(),
});
const grepParams = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  include: z.string().optional(),
  exclude: z.string().optional(),
  before: z.number().int().nonnegative().optional(),
  after: z.number().int().nonnegative().optional(),
  from: z.number().int().positive().optional(),
  count: z.number().int().positive().optional(),
});
const listParams = z.object({
  path: z.string().optional(),
  include: z.string().optional(),
  from: z.number().int().positive().optional(),
});
const editParams = z.object({ path: z.string(), find: z.string(), replace: z.string() });
const runParams = z.object({
  command: z.string().optional(),
  target: z.string().optional(),
  under: z.array(z.string()).optional(),
  background: z.boolean().optional(),
  job: z.string().optional(),
});
const writeParams = z.object({ path: z.string(), content: z.string() });

// The descriptions carry the operation, its required fields and the refusals to avoid;
// the strategy lives in SYSTEM_PROMPT (single source of truth).
const DEFINITIONS: { name: string; description: string; schema: z.ZodTypeAny }[] = [
  {
    name: "create_goal",
    description:
      "Propose a goal: an interpretation of the request, a stage sub-goal, or a hypothesis. The focus is the request or an open goal. Give plan (2-4 stage sub-goals) for a non-trivial task. Refused if: what is empty; done_when is empty; switching approach without listing EVERY failed option in revises (missing_revision); repeating a refuted hypothesis.",
    schema: createGoalParams,
  },
  {
    name: "complete",
    description:
      "Close the goal IN FOCUS as satisfied (subjective goals only). Refused if: it is not the focus (settle the focus first); it is the request; or it is objective (settle an objective goal with run {target}).",
    schema: completeParams,
  },
  {
    name: "query",
    description:
      "Re-read an already-known result by id instead of repeating a read/grep/run — its body is stored under the id shown in calls; optional line window (start/end). Refused if the id is already in shown.",
    schema: queryParams,
  },
  {
    name: "read",
    description:
      "Read a window of at most 400 lines of a file (1-based, end inclusive); without start/end, from the top. Refused if the file does not exist, or the same unchanged window is re-read — fetch that id with query instead.",
    schema: readParams,
  },
  {
    name: "grep",
    description:
      "Search file contents; path scopes to a file or directory, include is a path glob. The result is JSON windows — page with from/count, do not change the pattern. Refused if the same scope+pattern is repeated unchanged — fetch the id with query.",
    schema: grepParams,
  },
  {
    name: "list",
    description:
      "List files (JSON) to see what exists before choosing a grep include; page with from. Refused if the same listing is repeated unchanged — fetch the id with query.",
    schema: listParams,
  },
  {
    name: "edit",
    description:
      "Exact substring replacement (path, find, replace) in an EXISTING file. Refused if: find is not present; the file changed since its last read (stale_base) — re-read first; a constraint forbids the path; or the file does not exist (create it with write).",
    schema: editParams,
  },
  {
    name: "run",
    description:
      "Run a shell command, or check a goal. With target (an objective goal id) OMIT command — the engine runs the goal's own command, and target MUST be the current focus. Without target pass command (exploratory evidence, not a check). background:true starts a long command; poll it with job:<id>. Refused if: target is not the focus or is subjective; an unchanged check is repeated (a timeout may be retried); a check is backgrounded.",
    schema: runParams,
  },
  {
    name: "write",
    description:
      "Create or overwrite a whole file (path, content). A new file is created; overwriting an EXISTING file requires that it was read and is unchanged (stale_base otherwise) — use edit for a small change. Refused if a constraint forbids the path.",
    schema: writeParams,
  },
];

function parametersOf(schema: z.ZodTypeAny): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

export const PROPOSAL_TOOLS: OpenAITool[] = DEFINITIONS.map((definition) => ({
  type: "function",
  function: {
    name: definition.name,
    description: definition.description,
    parameters: parametersOf(definition.schema),
  },
}));

function parseArgs(args: unknown): Record<string, unknown> {
  if (typeof args === "string") {
    const parsed: unknown = JSON.parse(args === "" ? "{}" : args);
    return (parsed as Record<string, unknown>) ?? {};
  }
  return (args as Record<string, unknown>) ?? {};
}

// Map a tool call (name + arguments) into the IR Action; the engine (logos) still decides.
export function toProposal(name: string, args: unknown, thought: string): Proposal {
  const a = parseArgs(args);
  let action: unknown;
  switch (name) {
    case "create_goal":
      action = { operator: "create_goal", ...a };
      break;
    case "complete":
      action = { operator: "complete", ...a };
      break;
    case "query":
      action = { operator: "query", ...a };
      break;
    case "read":
    case "grep":
    case "list":
    case "edit":
    case "run":
    case "write":
      action = { operator: "apply", action: { tool: name, ...a } };
      break;
    default:
      throw new Error(`unknown tool call: ${name}`);
  }
  return { thought, action: actionSchema.parse(action) as Action };
}
