import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Event } from "../../src/ir/events";
import { fold, type State } from "../../src/ir/graph";
import type { Action, PlanItem } from "../../src/llm/schemas";
import { classify, type Classification } from "../../src/loop/classify";
import { executeAction, type ExecOutcome } from "../../src/tools";
import { fsWorkspace, type Workspace, type WorkspaceOptions } from "../../src/tools/workspace";

// A seed request event: the root of every tree built in these tests.
export function request(text = "solve the task"): Event {
  return {
    type: "add_node",
    node: {
      id: "r1",
      space: "work",
      kind: "request",
      label: text,
      payload: { text },
      seq: 0,
    },
  };
}

export function foldAll(events: readonly Event[]): State {
  return fold(events);
}

export interface Executed {
  events: Event[];
  state: State;
  outcome: ExecOutcome;
}

// Apply an operator's effects to the journal and fold the new state, the way the loop
// does each turn (`fold(events)`, execute, append).
export function exec(action: Action, events: readonly Event[], workspace: Workspace, turn = 0): Executed {
  const outcome = executeAction(action, fold(events), workspace, turn);
  const all = [...events, ...outcome.events];
  return { events: all, state: fold(all), outcome };
}

export function classification(
  action: Action,
  events: readonly Event[],
  held: readonly string[] = [],
  queried: readonly string[] = [],
): Classification {
  return classify({ thought: "", action }, fold(events), held, queried);
}

// Shorthand constructors.
export function interpretation(what: string, command?: string, plan?: PlanItem[]): Action {
  return {
    operator: "create_goal",
    what,
    done_when:
      command === undefined
        ? { kind: "subjective", text: `${what} is done` }
        : { kind: "objective", command },
    ...(plan !== undefined ? { plan } : {}),
  };
}

export function applyTool(action: Extract<Action, { operator: "apply" }>["action"]): Action {
  return { operator: "apply", action };
}

export function read(path: string, start?: number, end?: number): Action {
  return applyTool({ tool: "read", path, ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}) });
}

export function grep(pattern: string, path?: string): Action {
  return applyTool({ tool: "grep", pattern, ...(path !== undefined ? { path } : {}) });
}

export function edit(path: string, find: string, replace: string): Action {
  return applyTool({ tool: "edit", path, find, replace });
}

export function write(path: string, content: string): Action {
  return applyTool({ tool: "write", path, content });
}

export function run(command: string): Action {
  return applyTool({ tool: "run", command });
}

export function fetchUrl(url: string, path?: string): Action {
  return applyTool({ tool: "fetch", url, ...(path !== undefined ? { path } : {}) });
}

export function patch(patchText: string, strip?: number): Action {
  return applyTool({ tool: "apply_patch", patch: patchText, ...(strip !== undefined ? { strip } : {}) });
}

export function check(target: string): Action {
  return applyTool({ tool: "run", target });
}

export function complete(goal?: string, note?: string, under?: string[]): Action {
  return {
    operator: "complete",
    ...(goal !== undefined ? { goal } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(under !== undefined ? { under } : {}),
  };
}

export function query(id?: string): Action {
  return { operator: "query", ...(id !== undefined ? { id } : {}) };
}

const roots: string[] = [];

export interface TempWorkspace {
  ws: Workspace;
  root: string;
}

// A real on-disk workspace; `files` are written before it is opened.
export function makeWorkspace(files: Record<string, string> = {}, options: WorkspaceOptions = {}): TempWorkspace {
  const root = mkdtempSync(join(tmpdir(), "skein-ops-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return { ws: fsWorkspace(root, options), root };
}

export const DEFAULT_FILES: Record<string, string> = {
  "src/sum.mjs": "export function sum(a, b) {\n  return a - b;\n}\n",
  "test/sum.test.mjs": "import { sum } from '../src/sum.mjs';\nif (sum(1, 2) !== 3) throw new Error('bad');\n",
};

export function cleanupWorkspaces(): void {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
