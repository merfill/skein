import { fold, type State } from "../../src/ir/graph";
import type { Event } from "../../src/ir/events";
import { executeAction } from "../../src/tools";
import type { Workspace } from "../../src/tools/workspace";
import type { Action } from "../../src/llm/schemas";
import { makeWorkspace, move, request, run } from "../ops/helpers";

export interface ObserverScenario {
  name: "entry_cycle" | "long_state";
  events: Event[];
  state: State;
  turn: number;
  workspace: Workspace;
}

function build(actions: Action[], workspace: Workspace): { events: Event[]; state: State; turn: number } {
  const events: Event[] = [request("synthetic observer task")];
  let turn = 0;
  for (const action of actions) {
    turn += 1;
    const outcome = executeAction(action, fold(events), workspace, turn);
    events.push(...outcome.events);
  }
  return { events, state: fold(events), turn };
}

export function entryCycleScenario(): ObserverScenario {
  const workspace = makeWorkspace({ "src/a.txt": "one\n" }).ws;
  const stop = (why: string): Action => ({ operator: "stop", why });
  const actions: Action[] = [
    move("orientation", "read the tree"),
    run("echo orient"),
    stop("oriented"),
    move("patch", "first fix"),
    run("echo patch-one"),
    stop("patched"),
    move("verification", "check"),
    run("echo verify-one"),
    stop("failed"),
    move("patch", "second fix"),
    run("echo patch-two"),
    stop("patched"),
    move("verification", "check"),
    run("echo verify-two"),
    stop("failed"),
    move("patch", "third fix"),
  ];
  return { name: "entry_cycle", workspace, ...build(actions, workspace) };
}

export function longStateScenario(): ObserverScenario {
  const workspace = makeWorkspace({ "src/a.txt": "one\n" }).ws;
  const actions: Action[] = [move("orientation", "survey the files")];
  for (let index = 1; index <= 21; index += 1) actions.push(run(`echo ${index}`));
  return { name: "long_state", workspace, ...build(actions, workspace) };
}
