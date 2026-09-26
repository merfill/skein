import { z } from "zod";

export const actionSchema = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("read"),
    path: z.string(),
    start: z.number().int().optional(),
    end: z.number().int().optional(),
  }),
  z.object({ tool: z.literal("grep"), pattern: z.string() }),
  z.object({
    tool: z.literal("edit"),
    path: z.string(),
    find: z.string(),
    replace: z.string(),
  }),
  z.object({
    tool: z.literal("run"),
    command: z.string(),
    claims: z.array(z.string()).optional(),
  }),
  z.object({
    tool: z.literal("track"),
    kind: z.enum(["claim", "decision", "constraint"]),
    label: z.string(),
    rationale: z.string().optional(),
    forbid: z.array(z.string()).optional(),
  }),
  z.object({ tool: z.literal("query"), selector: z.string() }),
  z.object({ tool: z.literal("finish"), summary: z.string() }),
]);

export type Action = z.infer<typeof actionSchema>;

export const proposalSchema = z.object({
  thought: z.string(),
  action: actionSchema,
});

export type Proposal = z.infer<typeof proposalSchema>;
