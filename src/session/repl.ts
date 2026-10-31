import {
  cancelTurn,
  resumeTurn,
  runSessionTurn,
  type PausedState,
  type SessionTurnDeps,
  type SessionTurnResult,
} from "./driver";
import { renderCancel, renderTurn, type RenderOptions } from "./view";
import { createSession } from "./session";
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

  const print = (lines: readonly string[]): void => {
    for (const line of lines) output(line);
  };
  const cancel = (state: PausedState): void => {
    print(renderCancel(cancelTurn(deps.task.workspace, session, state, deps.telemetry)));
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
  };
  const resume = async (state: PausedState): Promise<void> => {
    const current = signal();
    let result: SessionTurnResult;
    try {
      result = await resumeTurn(deps, session, state, {
        ...(current !== undefined ? { signal: current } : {}),
      });
    } finally {
      options.onTurnEnd?.();
    }
    print(renderTurn(result, options));
    paused = result.paused;
    options.onPauseChanged?.(result.paused !== undefined);
  };

  for await (const raw of input) {
    const line = raw.trim();
    if (paused !== undefined) {
      if (line === "" || line === "c" || line === "cancel") {
        cancel(paused);
        continue;
      }
      if (line === "r" || line === "resume") {
        await resume(paused);
        continue;
      }
      if (line === "q" || line === "quit") break;
      // Any other line cancels the paused work and is interpreted as a new utterance.
      cancel(paused);
      await run(session, line);
      continue;
    }
    if (line === "") continue;
    if (line === "exit" || line === "quit") break;
    await run(session, line);
  }
  return session;
}
