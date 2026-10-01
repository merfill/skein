import { z } from "zod";

import { EDGE_KINDS, NODE_KINDS, STATUSES } from "../ir/types";

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
    tool: z.literal("decompose"),
    parent: z.string(),
    label: z.string(),
  }),
  z.object({
    tool: z.literal("decide"),
    parent: z.string(),
    label: z.string(),
    alternatives: z.array(z.string()).optional(),
    rationale: z.string(),
  }),
  z.object({
    tool: z.literal("track"),
    kind: z.enum(["claim", "constraint"]),
    label: z.string(),
    parent: z.string().optional(),
    rationale: z.string().optional(),
    forbid: z.array(z.string()).optional(),
  }),
  z.object({
    tool: z.literal("query"),
    id: z.string().optional(),
    kind: z.enum(NODE_KINDS).optional(),
    status: z.enum(STATUSES).optional(),
    edgesOf: z.string().optional(),
    edgeKind: z.enum(EDGE_KINDS).optional(),
    verdictOf: z.string().optional(),
  }),
  z.object({ tool: z.literal("finish"), summary: z.string() }),
]);

export type Action = z.infer<typeof actionSchema>;

export const proposalSchema = z.object({
  thought: z.string(),
  action: actionSchema,
});

export type Proposal = z.infer<typeof proposalSchema>;
