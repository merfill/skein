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
// needs (e.g. `recall` without the state selectors, `grep` without `exclude`/`count`), and
// they use the names a coding model already knows (`filePath`/`offset`/`limit`, not
// `path`/`start`/`end`); the engine schema (`applySchema`) still accepts the full form and
// `toProposal` maps the native call back into the IR.
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
  filePath: z.string(),
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
});
const grepParams = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  include: z.string().optional(),
  from: z.number().int().positive().optional(),
});
const listParams = z.object({
  path: z.string().optional(),
  include: z.string().optional(),
  from: z.number().int().positive().optional(),
});
const editParams = z.object({ filePath: z.string(), oldString: z.string(), newString: z.string() });
const bashParams = z.object({
  command: z.string(),
  workdir: z.string().optional(),
  timeout: z.number().int().positive().optional(),
});
const writeParams = z.object({ filePath: z.string(), content: z.string() });
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
      "Search INSIDE a stored result (an earlier observation), by id, for a regular expression — return matching line windows as plain text (line-numbered), with before/after context (default 3/3). Use it to locate a marker in a big stored output (a diff, a log, a build log) without paging it line by line; this searches stdout AND stderr of a stored run. It is not `grep` (which searches workspace files): the target here is one stored result id. A very broad pattern returns few candidates — narrow it.",
    schema: searchParams,
  },
  {
    name: "read",
    description:
      "Read a file from the local filesystem (filePath). Returns at most ~8K chars; offset is the 1-indexed line to start from and limit is the maximum number of lines to read (without them, from the top). Use grep to find content in large files. A larger file reports \"[lines X-Y of Z; continue from Y+1]\" — page it with a new offset. Re-reading the SAME window in an unchanged world is a repeat (refused): recall the stored result by id instead. Refused if the file does not exist.",
    schema: readParams,
  },
  {
    name: "grep",
    description:
      "Fast content search: search workspace file contents by regular expression (pattern), scoped by path (a file or directory) and include (a path glob, e.g. \"**/*.c\"). Returns line-numbered plain text (`path:line:match`, context `path-line-text`, default 3/3). from is the 1-based start and pages the results (default 50, max 100); a `[showing N of M; continue from K]` trailer says how. Re-running an identical search is refused: recall its stored result by id.",
    schema: grepParams,
  },
  {
    name: "list",
    description:
      "List workspace files as JSON; path/include scope the listing, from pages it (default 100 files, max 200). The window is kept small (~8K chars), so it is a pointer to what exists, not content. Use it to see what exists (e.g. which extensions) before choosing include in grep. Refused if the same listing is repeated unchanged — recall the id.",
    schema: listParams,
  },
  {
    name: "edit",
    description:
      "Performs exact string replacements in an EXISTING file (filePath, oldString, newString). Only the first occurrence of oldString is replaced, so make oldString unique; it does not create files — use write for that. Refused if: oldString is not found; the file changed since its last read (stale_base) — read it first; a constraint forbids the path; or the file does not exist.",
    schema: editParams,
  },
  {
    name: "bash",
    description:
      "Executes a given bash command. This tool is for terminal operations like git, make, npm, docker, scripting — do NOT use it for file operations (reading, writing, editing, searching): use read/grep/list/edit/write instead. command is required and runs from the WORKSPACE ROOT; pass workdir to run it in a subdirectory (instead of prefixing `cd <dir> &&`), and timeout (milliseconds) to cap it. bash BLOCKS until the command exits or the engine's cap elapses (minutes), so run a build or a test suite in the FOREGROUND — it returns exit 0/non-zero and the output. stdout and stderr are captured SEPARATELY (never merge with 2>&1). The shown output is its TAIL (up to ~8K chars; the error and exit are at the end); the full stream is stored and retrievable by id with recall {id, start, end}. Re-running an identical command in an unchanged world is refused as a repeat. For version control, inspect with git status/git diff/git log; do not commit or push unless the request asks.",
    schema: bashParams,
  },
  {
    name: "write",
    description:
      "Writes a file to the workspace (filePath, content): creates a NEW file or fully overwrites an existing one. Overwriting requires that the file was read and is unchanged since (stale_base otherwise); prefer edit for a small change. Refused if a constraint forbids the path.",
    schema: writeParams,
  },
  {
    name: "webfetch",
    description:
      "Fetches content from a URL and saves it into the workspace as read-only reference evidence (default path .skein/ref/<slug>), to read alongside the tree. Refused if: the target path is outside the workspace or already exists; a constraint forbids it; or the download fails (non-2xx/timeout).",
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

// Map a tool call (native name + arguments) into the IR Action; the engine (logos) still
// decides. The native vocabulary differs from the IR: read/edit/write use the familiar
// `filePath`/`offset`/`limit`/`oldString`/`newString` names, `webfetch` is the IR `fetch`,
// and grep drops the state-only selectors.
export function toProposal(name: string, args: unknown, thought: string): Proposal {
  const a = parseArgs(args);
  const present = (key: string): boolean => a[key] !== undefined;
  const pick = (key: string): Record<string, unknown> => (present(key) ? { [key]: a[key] } : {});
  let action: unknown;
  switch (name) {
    case "create_goal":
      action = { operator: "create_goal", what: a.what, command: a.command };
      break;
    case "recall":
      action = { operator: "recall", id: a.id, ...pick("start"), ...pick("end") };
      break;
    case "search":
      action = { operator: "search", id: a.id, pattern: a.pattern, ...pick("before"), ...pick("after") };
      break;
    case "stop":
      action = { operator: "stop", ...pick("why") };
      break;
    case "decline":
      action = { operator: "decline", ...pick("why") };
      break;
    case "read": {
      // The native `offset`/`limit` window maps to the IR inclusive `start`/`end`.
      const start = present("offset") ? (a.offset as number) : undefined;
      const end =
        present("limit") ? (start ?? 1) + (a.limit as number) - 1 : undefined;
      action = {
        operator: "apply",
        action: {
          tool: "read",
          path: a.filePath,
          ...(start !== undefined ? { start } : {}),
          ...(end !== undefined ? { end } : {}),
        },
      };
      break;
    }
    case "grep":
      action = {
        operator: "apply",
        action: { tool: "grep", pattern: a.pattern, ...pick("path"), ...pick("include"), ...pick("from") },
      };
      break;
    case "list":
      action = {
        operator: "apply",
        action: { tool: "list", ...pick("path"), ...pick("include"), ...pick("from") },
      };
      break;
    case "edit":
      action = {
        operator: "apply",
        action: { tool: "edit", path: a.filePath, find: a.oldString, replace: a.newString },
      };
      break;
    case "write":
      action = {
        operator: "apply",
        action: { tool: "write", path: a.filePath, content: a.content },
      };
      break;
    case "bash":
      action = {
        operator: "apply",
        action: { tool: "bash", command: a.command, ...pick("workdir"), ...pick("timeout") },
      };
      break;
    case "webfetch":
      action = { operator: "apply", action: { tool: "fetch", url: a.url, ...pick("path") } };
      break;
    case "apply_patch":
      action = { operator: "apply", action: { tool: "apply_patch", patch: a.patch, ...pick("strip") } };
      break;
    default:
      throw new Error(`unknown tool call: ${name}`);
  }
  return { thought, action: actionSchema.parse(action) as Action };
}
