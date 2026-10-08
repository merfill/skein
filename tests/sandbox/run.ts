import type { Event } from "../../src/ir/events";
import type { State } from "../../src/ir/graph";
import type { Action, Proposal } from "../../src/llm/schemas";
import { runAgent, type AgentResult } from "../../src/loop/graph";
import type { Proposer } from "../../src/loop/propose";
import type { Workspace } from "../../src/tools/workspace";
import { sandboxWorkspace, type SandboxSpec } from "./workspace";

// Run the real loop against a virtual workspace. `propose` is injected, so a test can be
// fully deterministic (a scripted proposer) or live (a model proposer) — the engine, its
// classify/refusal/staleness logic and the projection are the same as in production.

export interface SandboxRunOptions {
  maxTurns?: number;
  // External arbiter (I5). Omit to mirror an autonomous Harbor run: an arbiter goal then
  // never becomes addressed.
  arbiter?: (state: State, turn: number) => Event[];
  constraints?: { id: string; label: string; forbid?: string[] }[];
  // Test-only: stage the task's `solution/solve.sh` (and an apt shim) under `.skein/` so
  // the offline harness test can replay it. Never set on a live run (it would leak the
  // answer to the agent).
  stageSolution?: boolean;
  // Docker network mode for the task container; "none" (default) keeps the agent offline.
  network?: string;
}

export interface SandboxRun {
  result: AgentResult;
  workspace: Workspace;
}

export async function runSandbox(
  spec: SandboxSpec,
  request: string,
  propose: Proposer,
  options: SandboxRunOptions = {},
): Promise<SandboxRun> {
  const workspace = sandboxWorkspace(spec);
  const result = await runAgent(
    {
      propose,
      workspace,
      maxTurns: options.maxTurns ?? 24,
      ...(options.arbiter !== undefined ? { arbiter: options.arbiter } : {}),
    },
    {
      request: { id: "r1", text: request },
      ...(options.constraints !== undefined ? { constraints: options.constraints } : {}),
    },
  );
  return { result, workspace };
}

// A proposer that yields a fixed sequence of actions, then repeats `fallback`. The actions
// are plain `Action` values, so a test reads as the trajectory it exercises.
export function scripted(steps: readonly Action[], fallback?: Action): Proposer {
  let index = 0;
  return async (): Promise<Proposal> => {
    const action = index < steps.length ? steps[index] : fallback;
    index += 1;
    if (action === undefined) throw new Error("scripted proposer ran out of actions");
    return { thought: "", action };
  };
}
