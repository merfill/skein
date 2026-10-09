import { z } from "zod";

import { EDGE_KINDS, NODE_KINDS, SPACES } from "./types";

const nodeSchema = z.object({
  id: z.string(),
  space: z.enum(SPACES),
  kind: z.enum(NODE_KINDS),
  label: z.string(),
  payload: z.unknown().optional(),
  seq: z.number().int().nonnegative(),
});

const provenanceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("llm") }),
  z.object({ kind: z.literal("user"), turnId: z.string() }),
  z.object({ kind: z.literal("read"), ref: z.string(), version: z.string() }),
  z.object({
    kind: z.literal("grep"),
    pattern: z.string(),
    path: z.string().optional(),
    include: z.string().optional(),
    exclude: z.string().optional(),
    from: z.number().int().optional(),
    count: z.number().int().optional(),
  }),
  z.object({
    kind: z.literal("list"),
    path: z.string().optional(),
    include: z.string().optional(),
    exclude: z.string().optional(),
  }),
]);

const edgeSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  kind: z.enum(EDGE_KINDS),
  provenance: provenanceSchema,
});

export const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add_node"), node: nodeSchema }),
  z.object({ type: z.literal("add_edge"), edge: edgeSchema }),
  z.object({ type: z.literal("descend"), node: z.string() }),
  z.object({ type: z.literal("return") }),
  z.object({
    type: z.literal("mutate"),
    ref: z.string(),
    version: z.string(),
    actionId: z.string(),
  }),
  z.object({
    type: z.literal("record_rejection"),
    tool: z.string(),
    target: z.string(),
    reason: z.string(),
    constraintId: z.string().optional(),
    turn: z.number().int().nonnegative(),
  }),
]);

export type Event = z.infer<typeof eventSchema>;
export type EventInput = z.input<typeof eventSchema>;
