import { z } from "zod";

import { EDGE_KINDS, NODE_KINDS, SPACES, type Verdict } from "./types";

const verdictSchema = z.enum(["pass", "fail", "inconclusive"]);

const witnessEntrySchema = z.object({ ref: z.string(), version: z.string() });

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
  z.object({
    type: z.literal("record_check"),
    id: z.string().optional(),
    command: z.string(),
    verdict: verdictSchema,
    output: z.string(),
    outputRef: z.string().optional(),
    // stderr, kept separate from stdout: the primary signal of a failed run.
    error: z.string().optional(),
    errorRef: z.string().optional(),
    actor: z.enum(["arbiter", "user"]).optional(),
    witness: z.array(witnessEntrySchema).optional(),
    targets: z.array(z.string()),
    under: z.array(z.string()).optional(),
  }),
]);

export type Event = z.infer<typeof eventSchema>;
export type EventInput = z.input<typeof eventSchema>;

export type { Verdict };
