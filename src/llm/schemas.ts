import { z } from "zod";

import type { DoneWhen } from "../ir/types";

export const doneWhenSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("objective"), command: z.string() }),
  z.object({ kind: z.literal("subjective"), text: z.string() }),
]);

export interface GoalItem {
  kind: "goal";
  what: string;
  why?: string;
  done_when: DoneWhen;
  plan?: PlanItem[];
}

export interface ActionItem {
  kind: "action";
  command: string;
  label?: string;
}

export type PlanItem = GoalItem | ActionItem;

const planItemSchema: z.ZodType<PlanItem> = z.lazy(() =>
  z.union([
    z.object({
      kind: z.literal("action"),
      command: z.string(),
      label: z.string().optional(),
    }),
    z.object({
      kind: z.literal("goal"),
      what: z.string(),
      why: z.string().optional(),
      done_when: doneWhenSchema,
      plan: z.array(planItemSchema).nonempty().optional(),
    }),
  ]),
);

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
    before: z.number().int().nonnegative().optional(),
    after: z.number().int().nonnegative().optional(),
  }),
  z.object({
    tool: z.literal("edit"),
    path: z.string(),
    find: z.string(),
    replace: z.string(),
  }),
  z.object({
    tool: z.literal("run"),
    command: z.string(),
    target: z.string().optional(),
    under: z.array(z.string()).optional(),
  }),
]);

export type Apply = z.infer<typeof applySchema>;

export const actionSchema = z.discriminatedUnion("operator", [
  z.object({
    operator: z.literal("create_goal"),
    what: z.string(),
    why: z.string().optional(),
    done_when: doneWhenSchema,
    plan: z.array(planItemSchema).nonempty().optional(),
    revises: z.array(z.string()).optional(),
  }),
  z.object({ operator: z.literal("apply"), action: applySchema }),
  z.object({
    operator: z.literal("complete"),
    goal: z.string().optional(),
    note: z.string().optional(),
    under: z.array(z.string()).optional(),
  }),
  z.object({
    operator: z.literal("query"),
    id: z.string().optional(),
    kind: z.string().optional(),
    predicate: z.string().optional(),
    edgesOf: z.string().optional(),
  }),
]);

export type Action = z.infer<typeof actionSchema>;

// The model may ask for prior results to be shown in full on the next turn; the cap
// is a safety guard, declared in the prompt (docs/context_design_ru.md §8).
export const MAX_NEED = 5;

export const proposalSchema = z.object({
  thought: z.string(),
  action: actionSchema,
  need: z.array(z.string()).max(MAX_NEED).optional(),
});

export type Proposal = z.infer<typeof proposalSchema>;
