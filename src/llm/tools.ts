import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { ISLAND_IDS, type IslandId } from "../ir/islands";
import { actionSchema, applySchema, type Action, type Apply, type Proposal } from "./schemas";

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
// The state: the island of work the doxa will work in AND the state's goal text (`what`) and its
// stop criterion (`done`) — the state IS its goal (docs/plans/archive/goal_into_move_plan.md).
// Only `state` is required: `what` falls back to the island's goal and `done` to its criterion
// when omitted. `notes` carries the request's presumptions (assumptions to verify) into the state.
const moveParams = z.object({
  state: z.enum(ISLAND_IDS),
  what: z.string().optional(),
  done: z.string().optional(),
  notes: z.string().optional(),
});
const stopParams = z.object({ why: z.string() });
const declineParams = z.object({ why: z.string().optional() });

// The descriptions carry the operation, its required fields and the refusals to avoid;
// the strategy lives in SYSTEM_PROMPT (single source of truth).
const DEFINITIONS: { name: string; description: string; schema: z.ZodTypeAny }[] = [
  {
    name: "move",
    description:
      `Declare the state you will work in: move { state, what, done, notes }. Call \`move\` alone — never batch it with other calls. Only \`state\` is required. what = the object or situation this state works on — optional; leave it out and the state's default goal applies. done = the criterion for THIS state — optional; leave it out and the state's default criterion applies. Never restate the whole task and never do another state's work — name the place or situation, do not derive the result. notes = what the request presumes about this state, carried in as an assumption to verify against the material. One short sentence each — up to ~20 words.`,
    schema: moveParams,
  },
  {
    name: "recall",
    description:
      "Read a STORED RESULT by id — the body addressed by the id shown in the tape (`[id] …`). Without start/end the body starts from the top; start/end page a large body (the result reports a \"continue from N\" cursor). Refused if the same id is recalled with no window while its body is already in view; a windowed recall is new content.",
    schema: recallParams,
  },
  {
    name: "search",
    description:
      "Search INSIDE a stored result (an earlier observation) by id, for a regular expression. Returns matching line windows as plain text (line-numbered), with before/after context (default 3/3). Searches stdout AND stderr of a stored run. The target is one stored result id.",
    schema: searchParams,
  },
  {
    name: "read",
    description:
      "Read a file from the local filesystem (filePath). Returns at most ~8K chars; offset is the 1-indexed line to start from and limit is the maximum number of lines to read (without them, from the top). A larger file reports \"[lines X-Y of Z; continue from Y+1]\" — page it with a new offset. Re-reading the SAME window when nothing has been modified is refused as a repeat. Refused if the file does not exist.",
    schema: readParams,
  },
  {
    name: "grep",
    description:
      "Fast content search: search workspace file contents by regular expression (pattern), scoped by path (a file or directory) and include (a path glob, e.g. \"**/*.c\"). Returns line-numbered plain text (`path:line:match`, context `path-line-text`, default 3/3). `from` is the 1-based start and pages the results (default 50, max 100); a `[showing N of M; continue from K]` trailer says how. Re-running an identical search is refused; the stored result remains on the tape.",
    schema: grepParams,
  },
  {
    name: "list",
    description:
      "List workspace files as JSON; path/include scope the listing, from pages it (default 100 files, max 200). The window is kept small (~8K chars): a pointer to what exists, not content. Refused if the same listing is repeated unchanged.",
    schema: listParams,
  },
  {
    name: "edit",
    description:
      "Performs exact string replacements in an EXISTING file (filePath, oldString, newString). Only the first occurrence of oldString is replaced, so make oldString unique. Creates no file. Refused if: oldString is not found; the file was modified since its last read (stale_base); a constraint forbids the path; or the file does not exist.",
    schema: editParams,
  },
  {
    name: "bash",
    description:
      "Executes a given bash command. command is required and runs from the WORKSPACE ROOT; workdir runs it in a subdirectory; timeout (milliseconds) caps it. Blocks until the command exits or the engine's cap elapses; returns exit 0/non-zero. stdout and stderr are captured separately. The shown output is its TAIL (up to ~8K chars; the error and exit are at the end); the full stream is stored and retrievable by id. Re-running an identical command when nothing has been modified is refused as a repeat.",
    schema: bashParams,
  },
  {
    name: "write",
    description:
      "Writes a file to the workspace (filePath, content): creates a NEW file or fully overwrites an existing one. Overwriting requires that the file was read and has not been modified since (stale_base otherwise). Refused if a constraint forbids the path.",
    schema: writeParams,
  },
  {
    name: "webfetch",
    description:
      "Fetches content from a URL and saves it (with `path`, into the workspace; without `path`, to the engine-owned ref) as a read-only file. Refused if: the target path is outside the workspace or already exists; a constraint forbids it; or the download fails (non-2xx/timeout).",
    schema: fetchParams,
  },
  {
    name: "apply_patch",
    description:
      "Apply a unified diff to the workspace (patch, optional strip; default patch -p1). Refused if the patch does not apply cleanly. Records the edited files.",
    schema: patchParams,
  },
  {
    name: "stop",
    description:
      `Call \`stop\` when this state's criterion holds. why = where and why you stopped, with the reasoning and the detail the state after it needs — up to ~50 words.`,
    schema: stopParams,
  },
  {
    name: "decline",
    description:
      "Decline to formulate a goal: the request's intent is not actionable (e.g. chit-chat, no task). Use it INSTEAD of inventing a goal. Available only while the request has no state yet; records an unactionable node under the request and ends the run. Give why.",
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

// The AI SDK tool set for the names on the model surface. The zod schemas stay the single
// source: the AI SDK validates the model's call against them before it reaches `toProposal`.
// There is no `execute` — a call is the structured-output channel for the proposed `Action`,
// never a tool the SDK runs (`stopWhen: stepCountIs(1)` in `structured.ts`).
const PATCH_BASH_SUFFIX =
  "This state changes the target: make the change specific and targeted; do not use wildcard " +
  "edits or deletes and do not touch unrelated files.";
const RECOVERY_BASH_SUFFIX =
  "This state reconstructs data from a source: you may create and modify files (the output, " +
  "scratch copies); keep the source read-only; do not edit the source.";
const CONSTRUCTION_BASH_SUFFIX =
  "This state builds a new artifact: write only the artifact and its acceptance check; do not " +
  "modify the source or unrelated files.";

// The bash tool is dual-use (inspection and mutation). The productive states get their own
// targeted rule; every other state (and a direct caller without an island) gets the global
// description, which carries no state-specific read-only prohibition.
function baseDescription(name: string): string {
  return PROPOSAL_TOOLS.find((tool) => tool.function.name === name)?.function.description ?? "";
}

export function bashDescriptionFor(island?: IslandId): string {
  const base = baseDescription("bash");
  if (island === "patch") return `${PATCH_BASH_SUFFIX} ${base}`;
  if (island === "recovery") return `${RECOVERY_BASH_SUFFIX} ${base}`;
  if (island === "construction") return `${CONSTRUCTION_BASH_SUFFIX} ${base}`;
  return base;
}

const INSPECTION_WEBFETCH_SUFFIX =
  "Inspection only in this state: omit `path` so the fetch goes to the engine-owned ref; do not " +
  "create files in the work tree. It never overwrites.";
const PATCH_WEBFETCH_SUFFIX =
  "This state changes the target: use `path` only for an artifact the goal names; it creates a " +
  "new workspace file and never overwrites.";
const CONSTRUCTION_WEBFETCH_SUFFIX =
  "This state builds a new artifact: use `path` only for a declared input or reference; it " +
  "creates a new file and never overwrites.";
const PATCH_EDIT_SUFFIX =
  "This state changes the target: edit only the target the goal names; do not edit raw artifacts, " +
  "unrelated files, or sibling code; make the replacement exact and targeted.";
const PATCH_WRITE_SUFFIX =
  "This state changes the target: write only the artifact the goal names, at its exact path; do " +
  "not overwrite source or raw artifacts; prefer edit for a small change.";
const PATCH_APPLY_PATCH_SUFFIX =
  "This state changes the target: apply only the diff the goal names; do not delete or rename " +
  "files outside the goal; check the patch paths; a wrong patch may not be revertible.";
const RECOVERY_WRITE_SUFFIX =
  "This state reconstructs data from a source: write the required output or scratch copies; do " +
  "not overwrite the source.";
const CONSTRUCTION_EDIT_SUFFIX =
  "This state builds a new artifact: edit only the artifact you are building; do not modify the " +
  "source or unrelated files.";
const CONSTRUCTION_WRITE_SUFFIX =
  "This state builds a new artifact: write only the new artifact or its acceptance check; do not " +
  "overwrite the source.";
const CONSTRUCTION_APPLY_PATCH_SUFFIX =
  "This state builds a new artifact: apply only a diff to that artifact; do not modify the source " +
  "or unrelated files.";

// The state-specific tool contract: `bash` is dual-use; `webfetch` creates a file; the write
// tools belong to the productive states — Patch (existing artifact), Recovery (output/search
// script), Construction (new artifact) — and never to the inspection states. The map is empty
// when no island is known (direct callers/tests), which keeps the global descriptions.
export function toolDescriptionsFor(island?: IslandId): Record<string, string> {
  if (island === undefined) return {};
  const webfetch =
    island === "patch"
      ? PATCH_WEBFETCH_SUFFIX
      : island === "construction"
        ? CONSTRUCTION_WEBFETCH_SUFFIX
        : INSPECTION_WEBFETCH_SUFFIX;
  const descriptions: Record<string, string> = {
    bash: bashDescriptionFor(island),
    webfetch: `${webfetch} ${baseDescription("webfetch")}`,
  };
  if (island === "patch") {
    descriptions.edit = `${PATCH_EDIT_SUFFIX} ${baseDescription("edit")}`;
    descriptions.write = `${PATCH_WRITE_SUFFIX} ${baseDescription("write")}`;
    descriptions.apply_patch = `${PATCH_APPLY_PATCH_SUFFIX} ${baseDescription("apply_patch")}`;
  } else if (island === "recovery") {
    descriptions.write = `${RECOVERY_WRITE_SUFFIX} ${baseDescription("write")}`;
  } else if (island === "construction") {
    descriptions.edit = `${CONSTRUCTION_EDIT_SUFFIX} ${baseDescription("edit")}`;
    descriptions.write = `${CONSTRUCTION_WRITE_SUFFIX} ${baseDescription("write")}`;
    descriptions.apply_patch = `${CONSTRUCTION_APPLY_PATCH_SUFFIX} ${baseDescription("apply_patch")}`;
  }
  return descriptions;
}

export function proposalTools(
  names?: ReadonlySet<string>,
  descriptions?: Record<string, string>,
): ToolSet {
  const tools: ToolSet = {};
  for (const definition of DEFINITIONS) {
    if (names !== undefined && !names.has(definition.name)) continue;
    tools[definition.name] = tool({
      description: descriptions?.[definition.name] ?? definition.description,
      inputSchema: definition.schema,
    });
  }
  return tools;
}

function parseArgs(args: unknown): Record<string, unknown> {
  if (typeof args === "string") {
    const parsed: unknown = JSON.parse(args === "" ? "{}" : args);
    return (parsed as Record<string, unknown>) ?? {};
  }
  return (args as Record<string, unknown>) ?? {};
}

// The native tool names that map to an IR `apply`. Shared by the standalone call and by the
// nested `action` of `create_goal`.
export const APPLY_TOOL_NAMES = new Set([
  "read",
  "grep",
  "list",
  "edit",
  "write",
  "bash",
  "webfetch",
  "apply_patch",
]);

// The tools the model surface offers for a given frontier (`applicable`): the doxa only ever
// sees the moves the engine would accept, so a refused move cannot be called at all
// (docs/ir_semantics.md §2.6). `recall`/`search` are read-only and always available. The apply
// vocabulary is the frontier's `applies` (the focused island's tools): when omitted, the full
// registry is bound (direct `invokeTools` callers, tests).
export function toolNamesFor(frontier: {
  move: boolean;
  apply: boolean;
  stop: boolean;
  decline: boolean;
  applies?: readonly string[];
}): string[] {
  const names = new Set<string>();
  if (frontier.move) names.add("move");
  if (frontier.stop) names.add("stop");
  if (frontier.decline) names.add("decline");
  if (frontier.apply) {
    // Recall/search read stored results into the open state's tape; they are offered only
    // while a state is open (with the apply surface and `stop`).
    names.add("recall");
    names.add("search");
    for (const name of frontier.applies ?? APPLY_TOOL_NAMES) names.add(name);
  }
  return PROPOSAL_TOOLS.filter((tool) => names.has(tool.function.name)).map(
    (tool) => tool.function.name,
  );
}

// The IR apply-tool → native tool name (the two differ only for `fetch` ↔ `webfetch`). Used to
// check an already-mapped action against a state's `applies` (`src/loop/classify.ts`).
const APPLY_TOOL_NATIVE: Record<string, string> = {
  read: "read",
  grep: "grep",
  list: "list",
  edit: "edit",
  write: "write",
  bash: "bash",
  fetch: "webfetch",
  apply_patch: "apply_patch",
};
export const nativeToolName = (tool: string): string => APPLY_TOOL_NATIVE[tool] ?? tool;

// Map a native tool call (`name` + `args`) into the IR `Apply`. One vocabulary for a
// standalone tool call and for the seed carried inside `create_goal`.
function toApply(name: string, a: Record<string, unknown>): Apply {
  const present = (key: string): boolean => a[key] !== undefined;
  const pick = (key: string): Record<string, unknown> => (present(key) ? { [key]: a[key] } : {});
  let apply: unknown;
  switch (name) {
    case "read": {
      // The native `offset`/`limit` window maps to the IR inclusive `start`/`end`.
      const start = present("offset") ? (a.offset as number) : undefined;
      const end = present("limit") ? (start ?? 1) + (a.limit as number) - 1 : undefined;
      apply = {
        tool: "read",
        path: a.filePath,
        ...(start !== undefined ? { start } : {}),
        ...(end !== undefined ? { end } : {}),
      };
      break;
    }
    case "grep":
      apply = { tool: "grep", pattern: a.pattern, ...pick("path"), ...pick("include"), ...pick("from") };
      break;
    case "list":
      apply = { tool: "list", ...pick("path"), ...pick("include"), ...pick("from") };
      break;
    case "edit":
      apply = { tool: "edit", path: a.filePath, find: a.oldString, replace: a.newString };
      break;
    case "write":
      apply = { tool: "write", path: a.filePath, content: a.content };
      break;
    case "bash":
      apply = { tool: "bash", command: a.command, ...pick("workdir"), ...pick("timeout") };
      break;
    case "webfetch":
      apply = { tool: "fetch", url: a.url, ...pick("path") };
      break;
    case "apply_patch":
      apply = { tool: "apply_patch", patch: a.patch, ...pick("strip") };
      break;
    default:
      throw new Error(`unknown apply tool: ${name}`);
  }
  return applySchema.parse(apply) as Apply;
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
    case "move":
      action = {
        operator: "move",
        state: a.state,
        what: typeof a.what === "string" ? a.what : "",
        ...(typeof a.done === "string" ? { done: a.done } : {}),
        ...pick("notes"),
      };
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
    default:
      if (APPLY_TOOL_NAMES.has(name)) {
        action = { operator: "apply", action: toApply(name, a) };
        break;
      }
      throw new Error(`unknown tool call: ${name}`);
  }
  return { thought, action: actionSchema.parse(action) as Action };
}
