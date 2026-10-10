import { z } from "zod";

import { actionSchema, type Action, type Proposal } from "./schemas";

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
// needs (e.g. `recall` without the state selectors, `list` without `exclude`/`limit`); the
// engine schema (`applySchema`) still accepts the full form.
const createGoalParams = z.object({
  what: z.string(),
  command: z.string(),
});
const recallParams = z.object({
  id: z.string(),
  start: z.number().int().positive().optional(),
  end: z.number().int().positive().optional(),
});
const searchParams = z.object({
  id: z.string(),
  pattern: z.string(),
  before: z.number().int().nonnegative().optional(),
  after: z.number().int().nonnegative().optional(),
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
      "Interpret the request (when the focus is the request; exactly once — the interpretation is FIXED) or add a sub-goal that branches the current plan item (when the focus is an open goal). Give what (the outcome) and command (the FIRST concrete action to run now). The engine executes that command from the WORKSPACE ROOT and returns its result; a plan item is any command, appended in order, one at a time — after each, decide the next from its result. If the project lives in a subdirectory (seen with list, or named in the request, e.g. `ocaml/`), the command MUST carry the `cd <dir> &&` prefix (`cd ocaml && make -C testsuite one DIR=tests/basic`), never the bare command. A sub-goal replaces the current plan item (its newest alternative); the focus descends into it. Refused if: what/command is empty; or the request already has an interpretation (interpreted).",
    schema: createGoalParams,
  },
  {
    name: "recall",
    description:
      "Read a STORED RESULT by id instead of repeating the command that produced it — the body is addressed by the id shown in the tape (`[id] …`). Without start/end the body starts from the top; give start/end to page a large body (the result reports a \"continue from N\" cursor). This reads a past result; searching it for a pattern is `search`, and reading a workspace FILE is `read`. Refused if the same id is recalled with no window while its body is already in view (redundant); a windowed recall is new content.",
    schema: recallParams,
  },
  {
    name: "search",
    description:
      "Search INSIDE a stored result (an earlier observation), by id, for a regular expression — return matching line windows as JSON, with before/after context (default 3/3). Use it to locate a marker in a big stored output (a diff, a log, a build log) without paging it line by line; this searches stdout AND stderr of a stored run. It is not `grep` (which searches workspace files): the target here is one stored result id. A very broad pattern returns few candidates — narrow it.",
    schema: searchParams,
  },
  {
    name: "read",
    description:
      "Read a window of a file (1-based, end inclusive); without start/end, from the top. The window is shown whole up to 64K chars (bounded by bytes only), so a normal file/function comes back in one read. The result reports \"[lines X-Y of Z; continue from Y+1]\" when the file has more. A different window is a new action; the SAME window with an unchanged world is a repeat (refused) — recall the stored result by id instead. Refused if the file does not exist.",
    schema: readParams,
  },
  {
    name: "grep",
    description:
      "Search file contents. path scopes to a file or directory; include/exclude are path globs (e.g. include \"**/*.c\" or \"runtime/**\", exclude \"**/.depend\"); before/after set context lines around each match (default 3/3). The result is JSON with matches grouped as windows: count matches per window (default 50, max 100), from is the 1-based start; when more matches remain, the summary says how to continue — page with a new grep (a new from). Re-running an identical search is refused — recall its stored result by id.",
    schema: grepParams,
  },
  {
    name: "list",
    description:
      "List files as JSON; path/include scope the listing, from pages it (default 100 files, max 200). The window is kept small (~8K chars), so it is a pointer to what exists, not content. Use it to see what exists (e.g. which extensions) before choosing include in grep. Refused if the same listing is repeated unchanged — recall the id.",
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
      "Run a shell command (the current plan item's command, or the next step). command is required and is one plain command; the engine runs it from the WORKSPACE ROOT. A run BLOCKS until the command exits or the engine's cap elapses (minutes), so run a build or a test suite in the FOREGROUND — it returns exit 0/non-zero and the output (stdout and stderr kept SEPARATE). The shown output is its TAIL (up to ~8K chars; the error and exit are at the end); the full stream is stored and retrievable by id with recall {id, start, end}. Re-running an identical command in an unchanged world is refused as a repeat.",
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
      "Fetch a URL into the workspace as read-only reference evidence (default path .skein/ref/<slug>), to read alongside the tree. Refused if: the target path is outside the workspace or already exists; a constraint forbids it; or the download fails (non-2xx/timeout).",
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
      "Stop: finish the focused goal. Records a `stop` relation on the goal (the closure and its reason sit at the goal, not as a plan item); the engine then returns to the parent, and the run ends when the request's goal is stopped. There is no stop on the request.",
    schema: stopParams,
  },
  {
    name: "decline",
    description:
      "Decline to formulate a goal: the request's intent is not actionable (e.g. chit-chat, no task). Use it INSTEAD of inventing a goal. Available only while the request has no interpretation yet; records an unactionable node under the request and ends the run. Give why.",
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
    case "recall":
      action = { operator: "recall", ...a };
      break;
    case "search":
      action = { operator: "search", ...a };
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
