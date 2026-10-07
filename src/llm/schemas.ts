import { z } from "zod";

import type { DoneWhen } from "../ir/types";

export const doneWhenSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("objective"), command: z.string() }),
  z.object({ kind: z.literal("arbiter"), text: z.string() }),
]);

// The first concrete step materialized in a goal's plan container (I2): a plan item is
// always an action, never a sub-goal.
export interface ActionStep {
  command: string;
  label?: string;
}

export const stepSchema = z.object({
  command: z.string(),
  label: z.string().optional(),
});

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
    target: z.string().optional(),
    under: z.array(z.string()).optional(),
    // Start the command in the background and return at once; poll it with `job`.
    background: z.boolean().optional(),
    // Poll a background job started earlier (its id came back as `job-N`).
    job: z.string().optional(),
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
    why: z.string().optional(),
    done_when: doneWhenSchema,
    plan: z.string(),
    step: stepSchema,
    revises: z.array(z.string()).optional(),
  }),
  z.object({ operator: z.literal("apply"), action: applySchema }),
  z.object({
    operator: z.literal("query"),
    id: z.string().optional(),
    kind: z.string().optional(),
    predicate: z.string().optional(),
    edgesOf: z.string().optional(),
    start: z.number().int().positive().optional(),
    end: z.number().int().positive().optional(),
  }),
]);

export type Action = z.infer<typeof actionSchema>;

export const proposalSchema = z.object({
  thought: z.string(),
  action: actionSchema,
});

export type Proposal = z.infer<typeof proposalSchema>;
