import { runSessionTurn, type SessionTurnDeps, type SessionTurnResult } from "./driver";
import { renderTurn, type RenderOptions } from "./view";
import { createSession } from "./session";
import type { SessionState } from "./types";

// The dialogue loop: read a line, run one driver turn, print the outcome. It has no terminal
// dependency, so a test can feed an async iterable of lines and collect the output.

export { renderTurn };
export type { RenderOptions };

export async function runRepl(
  input: AsyncIterable<string>,
  deps: SessionTurnDeps,
  output: (line: string) => void,
  session: SessionState = createSession(),
  options: RenderOptions = {},
): Promise<SessionState> {
  for await (const raw of input) {
    const line = raw.trim();
    if (line === "") continue;
    if (line === "exit" || line === "quit") break;
    const result: SessionTurnResult = await runSessionTurn(deps, session, line);
    for (const text of renderTurn(result, options)) output(text);
  }
  return session;
}
