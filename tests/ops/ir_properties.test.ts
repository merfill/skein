import { describe, expect, it } from "vitest";

import type { Event } from "../../src/ir/events";
import { fold, predicateOf } from "../../src/ir/graph";
import { project } from "../../src/ir/project";
import { achievedWithoutCheck, structuralCycle, unboundGoals } from "../invariants";

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

// Generate a random but LEGAL IR tree: every non-root goal is bound to a plan or
// alternatives container, closures use a check (objective) or complete (subjective),
// and structural edges form a forest. The generator only needs the shapes the engine
// must keep invariant, not the exact operator paths.
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

  let goals = 0;
  const buildGoal = (depth: number): string => {
    const id = `g${goals++}`;
    const objective = chance(0.5);
    const payload = objective
      ? { what: id, done_when: { kind: "objective", command: "make test" } }
      : { what: id, why: "hypothesis", done_when: { kind: "arbiter", text: "done" } };
    addNode(id, "goal", payload);

    // Sometimes a plan of 1..3 items.
    if (depth > 0 && chance(0.6)) {
      const plan = `p${id}`;
      addNode(plan, "plan");
      addEdge(id, plan, "has_plan");
      const count = 1 + Math.floor(rng() * 3);
      for (let i = 0; i < count; i += 1) {
        if (chance(0.5)) {
          const child = buildGoal(depth - 1);
          addEdge(plan, child, "item");
        } else {
          const action = `a${next()}`;
          addNode(action, "action", { command: "make test" });
          addEdge(plan, action, "item");
        }
      }
    }

    // Close it (at most once) so the predicates vary across seeds.
    if (objective && chance(0.5)) {
      events.push({ type: "record_check", command: "make test", verdict: pick(["pass", "fail", "inconclusive"] as const), output: "", targets: [id] });
    } else if (!objective && chance(0.5)) {
      const c = `c${id}`;
      addNode(c, "complete", { note: "accepted" });
      addEdge(c, id, "closes");
    } else if (chance(0.2)) {
      // An observation produced by an exploratory action under this goal.
      const obs = `o${clock}`;
      addNode(obs, "observation", { verdict: "fail" });
    }
    return id;
  };

  addNode("r1", "request", { text: "solve it" });
  const alt = "altr1";
  addNode(alt, "alternatives");
  addEdge("r1", alt, "has_alternatives");

  const interpretations: string[] = [];
  const count = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < count; i += 1) {
    const g = buildGoal(2);
    addEdge(alt, g, "item");
    interpretations.push(g);
  }
  addEdge(alt, pick(interpretations), "chosen");

  if (chance(0.3)) {
    events.push({ type: "add_node", node: { id: "constraint", space: "work", kind: "constraint", label: "no src", payload: { forbid: ["src/"] }, seq: next() } });
  }

  return events;
}

describe("IR properties (random legal trees)", () => {
  it("[DER-GOAL-1] no goal is achieved without a passing check, over 400 seeds", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const events = generate(seed);
      expect(achievedWithoutCheck(events), `seed ${seed}`).toEqual([]);
    }
  });

  it("[TR-6] every non-root goal is bound to a plan or alternatives, over 400 seeds", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      expect(unboundGoals(generate(seed)), `seed ${seed}`).toEqual([]);
    }
  });

  it("[OP-CG-4] structural edges form a forest, over 400 seeds", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      expect(structuralCycle(generate(seed)), `seed ${seed}`).toBe(false);
    }
  });

  it("fold is deterministic and project never throws, over 400 seeds", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const events = generate(seed);
      const a = fold(events);
      const b = fold(events);
      const predicatesA = [...a.nodes.keys()].map((id) => `${id}:${predicateOf(a, id)}`).sort();
      const predicatesB = [...b.nodes.keys()].map((id) => `${id}:${predicateOf(b, id)}`).sort();
      expect(predicatesA, `seed ${seed}`).toEqual(predicatesB);

      const ctxA = project(a);
      const ctxB = project(b);
      expect(JSON.stringify(ctxA), `seed ${seed}`).toBe(JSON.stringify(ctxB));
      expect(Array.isArray(ctxA.path)).toBe(true);
    }
  });
});
