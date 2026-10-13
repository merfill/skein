import { describe, expect, it } from "vitest";

import type { Event } from "../../src/ir/events";
import { actionExecuted, fold, hasStopped } from "../../src/ir/graph";
import { project } from "../../src/ir/project";
import { achievedWithoutCheck, structuralCycle } from "../invariants";
import { assertTapeContract } from "../tape_invariant";

// A tiny deterministic PRNG (mulberry32) — no external dependency.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Generate a random but LEGAL IR tree under the current semantics: a state (`move`) holds a
// plan of items, each item holds command alternatives; a state closes by a `stop` relation;
// structural edges form a forest (docs/ir_revision.md §2, docs/plans/goal_into_move_plan.md).
function generate(seed: number): Event[] {
  const rng = mulberry32(seed);
  const events: Event[] = [];
  let clock = 0;
  const next = () => clock++;
  const pick = <T>(xs: T[]): T => xs[Math.floor(rng() * xs.length)]!;
  const chance = (p: number) => rng() < p;

  const addNode = (id: string, kind: string, payload?: unknown): void => {
    events.push({ type: "add_node", node: { id, space: "work", kind: kind as never, label: id, ...(payload !== undefined ? { payload } : {}), seq: next() } });
  };
  const addEdge = (from: string, to: string, kind: string): void => {
    events.push({ type: "add_edge", edge: { id: `e${next()}`, from, to, kind: kind as never, provenance: { kind: "llm" } } });
  };
  // A state is closed by a `stop`: a `stop` relation from the state to a stop node.
  const close = (id: string): void => {
    const stop = `s${next()}`;
    addNode(stop, "stop");
    addEdge(id, stop, "stop");
  };

  let moves = 0;
  const buildState = (depth: number): string => {
    const id = `m${moves++}`;
    addNode(id, "move", { state: "patch", what: id, call: { name: "move", args: { state: "patch", what: id } } });

    // A plan of 1..3 items; each item holds command alternatives.
    if (depth > 0 && chance(0.6)) {
      const plan = `p${id}`;
      addNode(plan, "plan");
      addEdge(id, plan, "plan");
      const count = 1 + Math.floor(rng() * 3);
      for (let i = 0; i < count; i += 1) {
        const item = `i${next()}`;
        addNode(item, "item");
        addEdge(plan, item, "items");
        const action = `a${next()}`;
        addNode(action, "action", {
          command: "make test",
          call: { name: "bash", args: { command: "make test" } },
        });
        addEdge(item, action, "alts");
      }
    }

    // Close it (at most once) so the predicates vary across seeds.
    if (chance(0.5)) {
      close(id);
    } else if (chance(0.2)) {
      // An observation produced by an exploratory action under this state.
      const obs = `o${clock}`;
      addNode(obs, "observation", { failed: true });
    }
    return id;
  };

  addNode("r1", "request", { text: "solve it" });
  // The request declares its states as flat `move` children.
  addEdge("r1", buildState(2), "move");

  if (chance(0.3)) {
    events.push({ type: "add_node", node: { id: "constraint", space: "work", kind: "constraint", label: "no src", payload: { forbid: ["src/"] }, seq: next() } });
  }

  return events;
}

describe("IR properties (random legal trees)", () => {
  it("[DER-MOVE-1] no state is closed without a stop, over 400 seeds", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const events = generate(seed);
      expect(achievedWithoutCheck(events), `seed ${seed}`).toEqual([]);
    }
  });

  it("[DER-FOREST-1] structural edges form a forest, over 400 seeds", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      expect(structuralCycle(generate(seed)), `seed ${seed}`).toBe(false);
    }
  });

  it("fold is deterministic and project never throws, over 400 seeds", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const events = generate(seed);
      const a = fold(events);
      const b = fold(events);
      const predicatesA = [...a.nodes.keys()]
        .map((id) => `${id}:${hasStopped(a, id)}:${actionExecuted(a, id)}`)
        .sort();
      const predicatesB = [...b.nodes.keys()]
        .map((id) => `${id}:${hasStopped(b, id)}:${actionExecuted(b, id)}`)
        .sort();
      expect(predicatesA, `seed ${seed}`).toEqual(predicatesB);

      const ctxA = project(a);
      const ctxB = project(b);
      expect(JSON.stringify(ctxA), `seed ${seed}`).toBe(JSON.stringify(ctxB));
      expect(Array.isArray(ctxA.history)).toBe(true);
    }
  });

  it("[tape] every projected tape satisfies the role/pairing contract, over 400 seeds", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const ctx = project(fold(generate(seed)));
      expect(() => assertTapeContract(ctx.history), `seed ${seed}`).not.toThrow();
    }
  });
});
