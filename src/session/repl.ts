import {
  cancelTurn,
  executePlan,
  leaveTurn,
  resumeTurn,
  runSessionTurn,
  type PausedState,
  type SessionTurnDeps,
  type SessionTurnResult,
} from "./driver";
import {
  renderCancel,
  renderLeave,
  renderPauseMenu,
  renderPlanRun,
  renderTurn,
  type RenderOptions,
} from "./view";
import { planModeOf } from "./plan";
import { createSession, unitOf } from "./session";
import type { SessionState } from "./types";

// The dialogue loop: read a line, run one driver turn, print the outcome. It has no terminal
// dependency, so a test can feed an async iterable of lines and collect the output.

export { renderTurn };
export type { RenderOptions };

export interface ReplOptions extends RenderOptions {
  // A fresh signal per turn so a pause can be requested again after a resume.
  createSignal?: () => AbortSignal | undefined;
  // Told when the dialogue enters or leaves the pause menu (the terminal owns the keys).
  onPauseChanged?: (paused: boolean) => void;
  // Told after every driver call (running or resuming) so the terminal can clear its signal.
  onTurnEnd?: () => void;
}

export async function runRepl(
  input: AsyncIterable<string>,
  deps: SessionTurnDeps,
  output: (line: string) => void,
  session: SessionState = createSession(),
  options: ReplOptions = {},
): Promise<SessionState> {
  const signal = (): AbortSignal | undefined => options.createSignal?.();
  let paused: PausedState | undefined;
  // A developed plan waits for the user's menu choice; it is UI policy, not an IR state.
  let pendingPlan: string | undefined;

  const print = (lines: readonly string[]): void => {
    for (const line of lines) output(line);
  };
  const workspaceFor = (state: PausedState) =>
    state.agent === "general"
      ? (deps.general?.workspace ?? deps.task.workspace)
      : state.agent === "plan"
        ? (deps.planner?.workspace ?? deps.task.workspace)
        : state.agent === "document"
          ? (deps.document?.workspace ?? deps.task.workspace)
          : deps.task.workspace;
  const cancel = (state: PausedState): void => {
    print(renderCancel(cancelTurn(workspaceFor(state), session, state, deps.telemetry)));
    paused = undefined;
    options.onPauseChanged?.(false);
  };
  const leave = (state: PausedState): void => {
    print(renderLeave(leaveTurn(workspaceFor(state), session, state, deps.telemetry)));
    paused = undefined;
    options.onPauseChanged?.(false);
  };
  const run = async (state: SessionState, line: string): Promise<void> => {
    const current = signal();
    let result: SessionTurnResult;
    try {
      result = await runSessionTurn(deps, state, line, {
        ...(current !== undefined ? { signal: current } : {}),
      });
    } finally {
      options.onTurnEnd?.();
    }
    print(renderTurn(result, options));
    paused = result.paused;
    options.onPauseChanged?.(result.paused !== undefined);
    if (
      result.plan !== undefined &&
      result.plan.result.plan !== undefined &&
      result.plan.result.plan.items.length > 0
    ) {
      pendingPlan = result.plan.unitId;
    }
  };

  const execute = async (planUnitId: string): Promise<void> => {
    pendingPlan = undefined;
    const current = signal();
    let result;
    try {
      result = await executePlan(deps, session, planUnitId, {
        ...(current !== undefined ? { signal: current } : {}),
      });
    } finally {
      options.onTurnEnd?.();
    }
    print(renderPlanRun(result));
    paused = result.paused;
    options.onPauseChanged?.(result.paused !== undefined);
    if (
      result.plan !== undefined &&
      result.plan.result.plan !== undefined &&
      result.plan.result.plan.items.length > 0
    ) {
      pendingPlan = result.plan.unitId;
    } else if (result.status === "blocked" && planModeOf(session) === planUnitId) {
      pendingPlan = planUnitId;
      print(["plan is still active: [e]xecute to continue  [r]ework  [q]uit"]);
    }
  };

  const resume = async (
    state: PausedState,
    budgetAction?: "continue" | "finish",
  ): Promise<void> => {
    const current = signal();
    let result: SessionTurnResult;
    try {
      result = await resumeTurn(deps, session, state, {
        ...(current !== undefined ? { signal: current } : {}),
        ...(budgetAction !== undefined ? { budgetAction } : {}),
      });
    } finally {
      options.onTurnEnd?.();
    }
    print(renderTurn(result, options));
    paused = result.paused;
    options.onPauseChanged?.(result.paused !== undefined);
    if (
      result.plan !== undefined &&
      result.plan.result.plan !== undefined &&
      result.plan.result.plan.items.length > 0
    ) {
      pendingPlan = result.plan.unitId;
    }
    // A pause during plan execution resumed: continue the plan from the next pending item.
    if (paused === undefined && pendingPlan === undefined) {
      const unit = session.units.get(state.unitId);
      const planUnitId =
        state.planUnitId ??
        (unit?.planItem !== undefined ? planModeOf(session) : undefined);
      if (planUnitId !== undefined) await execute(planUnitId);
    }
  };

  for await (const raw of input) {
    const line = raw.trim();
    if (pendingPlan !== undefined && paused === undefined) {
      if (line === "e" || line === "execute") {
        await execute(pendingPlan);
        continue;
      }
      if (line === "r" || line === "rework") {
        pendingPlan = undefined;
        print(["plan kept; describe the changes and send them as the next message"]);
        continue;
      }
      if (line === "q" || line === "quit" || line === "exit") break;
      if (line === "") {
        print([`plan ready: [e]xecute  [r]ework  [q]uit`]);
        continue;
      }
      // Any other message is rework feedback: it goes to the session agent as usual.
      pendingPlan = undefined;
    }
    if (paused !== undefined) {
      if (paused.budget !== undefined) {
        if (line === "c" || line === "continue") {
          await resume(paused, "continue");
          continue;
        }
        if (line === "f" || line === "finish") {
          await resume(paused, "finish");
          continue;
        }
        if ((line === "s" || line === "session") && paused.agent !== "session") {
          leave(paused);
          continue;
        }
        if (line === "q" || line === "quit" || line === "exit") break;
        print([renderPauseMenu(paused)]);
        continue;
      }
      if (line === "r" || line === "resume") {
        await resume(paused);
        continue;
      }
      if ((line === "s" || line === "session") && paused.agent !== "session") {
        leave(paused);
        continue;
      }
      if (line === "c" || line === "cancel") {
        cancel(paused);
        continue;
      }
      if (line === "q" || line === "quit" || line === "exit") break;
      // A pause is resolved explicitly: never cancel or reinterpret implicitly.
      print([renderPauseMenu(paused)]);
      continue;
    }
    if (line === "") continue;
    if (line === "exit" || line === "quit") break;
    await run(session, line);
  }
  return session;
}
