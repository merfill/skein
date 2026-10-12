import { z } from "zod";

import { ISLAND_IDS } from "../ir/islands";

export const applySchema = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("read"),
    path: z.string(),
    start: z.number().int().optional(),
    end: z.number().int().optional(),
  }),
  z.object({
    tool: z.literal("grep"),
    pattern: z.string(),
    path: z.string().optional(),
    include: z.string().optional(),
    exclude: z.string().optional(),
    before: z.number().int().nonnegative().optional(),
    after: z.number().int().nonnegative().optional(),
    from: z.number().int().positive().optional(),
    count: z.number().int().positive().optional(),
  }),
  z.object({
    tool: z.literal("list"),
    path: z.string().optional(),
    include: z.string().optional(),
    exclude: z.string().optional(),
    from: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
  }),
  z.object({
    tool: z.literal("edit"),
    path: z.string(),
    find: z.string(),
    replace: z.string(),
  }),
  z.object({
    tool: z.literal("write"),
    path: z.string(),
    content: z.string(),
  }),
  z.object({
    tool: z.literal("bash"),
    command: z.string().optional(),
    // Run the command in this workspace path instead of the workspace root.
    workdir: z.string().optional(),
    // Per-command cap in milliseconds (the workspace default applies when absent).
    timeout: z.number().int().positive().optional(),
  }),
  z.object({
    // Fetch a URL into the workspace as read-only reference evidence, so it can be read
    // and diffed (docs/system_prompt.md B9).
    tool: z.literal("fetch"),
    url: z.string(),
    path: z.string().optional(),
  }),
  z.object({
    // Apply a unified diff to the workspace (e.g. an upstream change obtained with fetch).
    tool: z.literal("apply_patch"),
    patch: z.string(),
    // `patch -p<strip>` level; default 1 (a/…, b/… prefixes).
    strip: z.number().int().nonnegative().optional(),
  }),
]);

export type Apply = z.infer<typeof applySchema>;

export const actionSchema = z.discriminatedUnion("operator", [
  z.object({
    operator: z.literal("create_goal"),
    what: z.string(),
    // The island of work the goal is entered in (an authored label, never a gate).
    state: z.enum(ISLAND_IDS),
    // The first plan item: any tool, run at once as the goal's first item.
    action: applySchema,
  }),
  z.object({ operator: z.literal("apply"), action: applySchema }),
  z.object({ operator: z.literal("stop"), why: z.string().optional() }),
  // Decline to formulate a goal: the request's intent is not actionable. Creates an
  // `unactionable` node under the request and ends the run (docs/plans/request_goal_plan.md).
  z.object({ operator: z.literal("decline"), why: z.string().optional() }),
  z.object({
    // Read a stored result (an earlier observation) by id — a read/grep/run's output —
    // instead of repeating the command. An optional line window pages a large body.
    operator: z.literal("recall"),
    id: z.string(),
    start: z.number().int().positive().optional(),
    end: z.number().int().positive().optional(),
  }),
  z.object({
    // Search a stored result by a regular expression, returning matching line windows.
    operator: z.literal("search"),
    id: z.string(),
    pattern: z.string(),
    before: z.number().int().nonnegative().optional(),
    after: z.number().int().nonnegative().optional(),
  }),
]);

export type Action = z.infer<typeof actionSchema>;

// The native tool call a move corresponds to. The model emits one tool call per turn
// (`PROPOSAL_TOOLS`), so the tape can render the assistant's own history as
// `assistant.tool_calls` + `tool` messages instead of plain text (docs/ir_semantics §7).
export interface ModelCall {
  name: string;
  args: Record<string, unknown>;
}

// IR `Apply` → the native tool call the model emitted/expects. The reverse of `toProposal`
// (docs/ir_semantics §7): the tape renders the model's own history with these names/args, so
// it sees the same vocabulary it calls with (`filePath`/`offset`/`limit`, `webfetch`).
function nativeApply(action: Apply): ModelCall {
  switch (action.tool) {
    case "read": {
      const args: Record<string, unknown> = { filePath: action.path };
      if (action.start !== undefined) args.offset = action.start;
      if (action.end !== undefined) args.limit = action.end - (action.start ?? 1) + 1;
      return { name: "read", args };
    }
    case "grep": {
      const args: Record<string, unknown> = { pattern: action.pattern };
      if (action.path !== undefined) args.path = action.path;
      if (action.include !== undefined) args.include = action.include;
      if (action.from !== undefined) args.from = action.from;
      return { name: "grep", args };
    }
    case "list": {
      const args: Record<string, unknown> = {};
      if (action.path !== undefined) args.path = action.path;
      if (action.include !== undefined) args.include = action.include;
      if (action.from !== undefined) args.from = action.from;
      return { name: "list", args };
    }
    case "edit":
      return {
        name: "edit",
        args: { filePath: action.path, oldString: action.find, newString: action.replace },
      };
    case "write":
      return { name: "write", args: { filePath: action.path, content: action.content } };
    case "bash": {
      const args: Record<string, unknown> = { command: action.command ?? "" };
      if (action.workdir !== undefined) args.workdir = action.workdir;
      if (action.timeout !== undefined) args.timeout = action.timeout;
      return { name: "bash", args };
    }
    case "fetch":
      return {
        name: "webfetch",
        args: { url: action.url, ...(action.path !== undefined ? { path: action.path } : {}) },
      };
    case "apply_patch":
      return {
        name: "apply_patch",
        args: { patch: action.patch, ...(action.strip !== undefined ? { strip: action.strip } : {}) },
      };
  }
}

export function modelCall(action: Action): ModelCall {
  switch (action.operator) {
    case "create_goal":
      return {
        name: "create_goal",
        args: {
          what: action.what,
          state: action.state,
          // The seed rendered in the same native vocabulary as a standalone tool call, so the
          // tape shows the model its own nested `action` object back.
          action: { tool: nativeApply(action.action).name, ...nativeApply(action.action).args },
        },
      };
    case "apply":
      return nativeApply(action.action);
    case "stop":
      return { name: "stop", args: action.why !== undefined ? { why: action.why } : {} };
    case "decline":
      return { name: "decline", args: action.why !== undefined ? { why: action.why } : {} };
    case "recall":
      return {
        name: "recall",
        args: {
          id: action.id,
          ...(action.start !== undefined ? { start: action.start } : {}),
          ...(action.end !== undefined ? { end: action.end } : {}),
        },
      };
    case "search":
      return {
        name: "search",
        args: {
          id: action.id,
          pattern: action.pattern,
          ...(action.before !== undefined ? { before: action.before } : {}),
          ...(action.after !== undefined ? { after: action.after } : {}),
        },
      };
  }
}

export const proposalSchema = z.object({
  thought: z.string(),
  action: actionSchema,
});

export type Proposal = z.infer<typeof proposalSchema>;

// A doxa move: ONE thought (the assistant message text) plus one or more tool calls. The
// engine decides and executes each call in order (a batch); a single call is the common case.
// Calls sharing a move render as one `assistant.tool_calls` message with N calls + N results.
export interface Proposals {
  thought: string;
  actions: Action[];
}
