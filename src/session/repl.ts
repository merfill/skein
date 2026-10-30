import type { Event } from "../ir/events";
import { runSessionTurn, type SessionTurnDeps, type SessionTurnResult } from "./driver";
import { createSession } from "./session";
import type { SessionState } from "./types";

// The dialogue loop: read a line, run one driver turn, print the outcome. It has no terminal
// dependency, so a test can feed an async iterable of lines and collect the output.

function taskAnswer(events: readonly Event[]): string | undefined {
  let answer: string | undefined;
  for (const event of events) {
    if (event.type === "add_node" && event.node.kind === "stop") answer = event.node.label;
  }
  return answer;
}

export function renderTurn(result: SessionTurnResult): string[] {
  const lines: string[] = [];
  const operation = result.operation;
  if (operation === undefined) {
    lines.push("session: no action");
  } else if (operation.kind === "respond") {
    lines.push("session: respond");
  } else {
    lines.push(`session: start("${operation.text}")`);
  }
  if (result.applied !== undefined && !result.applied.ok) {
    lines.push(`refused: ${result.applied.reason}`);
  }
  if (result.reply !== undefined) lines.push(`answer: ${result.reply}`);
  if (result.task !== undefined) {
    const { unitId, result: run } = result.task;
    const outcome = run.done ? (run.stopReason ?? "done") : "still open";
    lines.push(`task ${unitId}: ${outcome} after ${run.turns} turns`);
    const answer = taskAnswer(run.events);
    if (run.done && answer !== undefined && answer !== "") lines.push(`task answer: ${answer}`);
  }
  return lines;
}

export async function runRepl(
  input: AsyncIterable<string>,
  deps: SessionTurnDeps,
  output: (line: string) => void,
  session: SessionState = createSession(),
): Promise<SessionState> {
  for await (const raw of input) {
    const line = raw.trim();
    if (line === "") continue;
    if (line === "exit" || line === "quit") break;
    const result = await runSessionTurn(deps, session, line);
    for (const text of renderTurn(result)) output(text);
  }
  return session;
}
