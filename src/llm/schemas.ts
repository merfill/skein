import { z } from "zod";

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
    tool: z.literal("run"),
    command: z.string().optional(),
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
    // The first plan item: the concrete command to run now.
    command: z.string(),
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

export const proposalSchema = z.object({
  thought: z.string(),
  action: actionSchema,
});

export type Proposal = z.infer<typeof proposalSchema>;
