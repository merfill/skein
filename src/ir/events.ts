import { z } from "zod";

import { EDGE_KINDS, NODE_KINDS, SPACES, STATUSES } from "./types";

const verdictSchema = z.enum(["pass", "fail"]);

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
  z.object({ kind: z.literal("grep"), pattern: z.string() }),
  z.object({
    kind: z.literal("check"),
    command: z.string(),
    verdict: verdictSchema,
    outputRef: z.string().optional(),
  }),
]);

const edgeSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  kind: z.enum(EDGE_KINDS),
  provenance: provenanceSchema,
  status: z.enum(STATUSES),
  version: z.string().optional(),
});

export const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add_node"), node: nodeSchema }),
  z.object({ type: z.literal("add_edge"), edge: edgeSchema }),
  z.object({
    type: z.literal("set_status"),
    id: z.string(),
    status: z.enum(STATUSES),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal("mutate"),
    ref: z.string(),
    version: z.string(),
    actionId: z.string(),
  }),
  z.object({
    type: z.literal("record_check"),
    command: z.string(),
    verdict: verdictSchema,
    output: z.string(),
    outputRef: z.string().optional(),
    claimIds: z.array(z.string()),
  }),
]);

export type Event = z.infer<typeof eventSchema>;
export type EventInput = z.input<typeof eventSchema>;
