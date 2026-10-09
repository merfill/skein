import { z } from "zod";

import {
  actionSchema,
  stepSchema,
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
  done_when: z.string(),
  plan: z.string(),
  step: stepSchema,
  revises: z.array(z.string()).optional(),
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
  background: z.boolean().optional(),
  job: z.string().optional(),
});
const writeParams = z.object({ path: z.string(), content: z.string() });
const fetchParams = z.object({ url: z.string(), path: z.string().optional() });
const patchParams = z.object({
  patch: z.string(),
  strip: z.number().int().nonnegative().optional(),
});
const stopParams = z.object({ why: z.string().optional() });
const declineParams = z.object({ why: z.string().optional() });

// The descriptions carry the operation, its required fields and the refusals to avoid;
// the strategy lives in SYSTEM_PROMPT (single source of truth).
const DEFINITIONS: { name: string; description: string; schema: z.ZodTypeAny }[] = [
  {
    name: "create_goal",
    description:
      "Interpret the request (when the focus is the request; exactly once — the interpretation is FIXED) or add a sub-goal that branches the current step (when the focus is an open goal). done_when is the literal command that verifies the goal (its criterion) — the engine runs it and reads the exit code (0 = pass, non-zero = fail); pick a command that really checks the work. Always give plan (a short free-form string sketch of the steps) and step: the FIRST concrete action to run now ({command, label?}). A plan item is always an action, appended in order; steps run one at a time — after each, decide the next from its result. A sub-goal replaces the current step (its newest alternative); the focus descends into it. When you replace a failed attempt, revises MUST list ALL failed options of the container by id, and the new what must differ from every failed one. Refused if: what/done_when/plan/step.command is empty; a failed option is omitted from revises (missing_revision); a failed hypothesis is repeated (repeat_hypothesis); the request already has an interpretation (interpreted); or the goal's plan is already fully carried out.",
    schema: createGoalParams,
  },
  {
    name: "query",
    description:
      "Re-read an already-known result by id instead of repeating a read/grep/run — its body is stored under the id shown in calls; optional line window (start/end). The body enters the working set for a few turns. Refused if the id is already in the working set (redundant).",
    schema: queryParams,
  },
  {
    name: "read",
    description:
      "Read a window of at most 400 lines of a file (1-based, end inclusive); without start/end, from the top. The result reports \"[lines X-Y of Z; continue from Y+1]\" when the file has more. A different window is a new action; the SAME window with an unchanged world is a repeat (refused) — fetch the stored result by id with query instead. Refused if the file does not exist.",
    schema: readParams,
  },
  {
    name: "grep",
    description:
      "Search file contents. path scopes to a file or directory; include/exclude are path globs (e.g. include \"**/*.c\" or \"runtime/**\", exclude \"**/.depend\"); before/after set context lines around each match (default 5/5). The result is JSON with matches grouped as windows: count matches per window (default 100, max 200), from is the 1-based start; when more matches remain, the summary says how to continue — page with a new grep (a new from), do NOT change the pattern. Choose where to search from the evidence: sources for logic (include by the project's language), output/logs for failures. Re-running an identical search is refused — fetch its stored result by id with query.",
    schema: grepParams,
  },
  {
    name: "list",
    description:
      "List files as JSON; path/include scope the listing, from pages it. Use it to see what exists (e.g. which extensions) before choosing include in grep. Refused if the same listing is repeated unchanged — fetch the id with query.",
    schema: listParams,
  },
  {
    name: "edit",
    description:
      "Exact substring replacement (path, find, replace) in an EXISTING file — it does not create files; use write to create or fully rewrite one. Refused if: find is not present; the file changed since its last read (stale_base) — re-read first; a constraint forbids the path; or the file does not exist.",
    schema: editParams,
  },
  {
    name: "run",
    description:
      "Run a shell command, or check a goal. With target (a goal id) OMIT command — the engine runs the goal's own done_when command (a different command is refused): exit 0 is a pass, non-zero a fail, a timeout leaves it open. target MUST be the current focus (path[last]); an ancestor or sibling is refused (not_current_goal) — settle the focus first. An identical re-check after a timeout is allowed. Without target, command is required (exploratory evidence, not a check). background:true starts a long command and returns at once with a job id; poll it with {job:\"<id>\"} until state \"done\" (the poll carries the exit code and the tail of the output); a background command is never a check.",
    schema: runParams,
  },
  {
    name: "write",
    description:
      "Create a NEW file, or fully overwrite an existing one (path, content). Overwriting requires that the file was read and is unchanged since (stale_base otherwise); prefer edit for a small change. Refused if a constraint forbids the path.",
    schema: writeParams,
  },
  {
    name: "fetch",
    description:
      "Fetch a URL into the workspace as read-only reference evidence (default path .skein/ref/<slug>). Use it to obtain an upstream/published/sibling copy, then DIFF it against the working copy — the diff isolates what changed (a fast localization). Refused if: the target path is outside the workspace or already exists; a constraint forbids it; or the download fails (non-2xx/timeout).",
    schema: fetchParams,
  },
  {
    name: "apply_patch",
    description:
      "Apply a unified diff to the workspace, e.g. an upstream change obtained with fetch (patch, optional strip; default patch -p1). Refused if the patch does not apply cleanly. Records the edited files.",
    schema: patchParams,
  },
  {
    name: "stop",
    description:
      "Stop: finish the focused goal. The engine appends a stop node as the goal's LAST plan item and records a has_stopped edge (the closure and its reason sit in the plan); it then returns to the request and the run ends. Accepted only once the goal's criterion has passed; otherwise refused (check_not_run) — run the check {target}, add a step, or revise. There is no stop on the request.",
    schema: stopParams,
  },
  {
    name: "decline",
    description:
      "Decline to formulate a goal: the request's intent is not actionable (e.g. chit-chat, no task). Use it INSTEAD of inventing a goal with a fake criterion. Available only while the request has no interpretation yet; records an unactionable node under the request and ends the run. Give why.",
    schema: declineParams,
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
    case "query":
      action = { operator: "query", ...a };
      break;
    case "stop":
      action = { operator: "stop", ...a };
      break;
    case "decline":
      action = { operator: "decline", ...a };
      break;
    case "read":
    case "grep":
    case "list":
    case "edit":
    case "run":
    case "write":
    case "fetch":
    case "apply_patch":
      action = { operator: "apply", action: { tool: name, ...a } };
      break;
    default:
      throw new Error(`unknown tool call: ${name}`);
  }
  return { thought, action: actionSchema.parse(action) as Action };
}
