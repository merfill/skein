import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadSettings } from "../../src/config/settings";
import type { Event } from "../../src/ir/events";
import { type State } from "../../src/ir/graph";
import type { Context } from "../../src/ir/project";
import { currentGoalId, goalPayload } from "../../src/ir/traversal";
import { createChatModel } from "../../src/llm/client";
import type { Action, Proposal } from "../../src/llm/schemas";
import { invokeTools } from "../../src/llm/structured";
import { runAgent, type AgentResult } from "../../src/loop/graph";
import { buildMessages, promptText } from "../../src/loop/propose";
import { fsWorkspace } from "../../src/tools/workspace";

// Live scenario harness: run the agent on a tiny fixture project and keep the full
// per-turn projection so a run can be analysed after the fact (which information the
// model had, what it fetched with `query`, which branches it hit). See
// docs/testing_ru.md §3.

export interface ScenarioConstraint {
  id: string;
  label: string;
  forbid?: string[];
}

export interface CapturedTurn {
  turn: number;
  action: Action;
  contextChars: number;
  context: Context;
}

export interface CheckOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ScenarioRun {
  name: string;
  result: AgentResult;
  root: string;
  before: Map<string, string>;
  turns: CapturedTurn[];
  check: CheckOutcome;
}

export interface RunOptions {
  constraints?: ScenarioConstraint[];
  maxTurns?: number;
  check?: string;
}

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const FIXTURES = join(REPO_ROOT, "fixtures", "scenarios");
const RUNS = join(REPO_ROOT, "bench", "runs");

function snapshotDir(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const path of fsWorkspace(root).list()) {
    snapshot.set(path, readFileSync(join(root, path), "utf8"));
  }
  return snapshot;
}

function readConstraints(fixture: string): ScenarioConstraint[] {
  const path = join(fixture, "constraints.json");
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")) as ScenarioConstraint[];
}

function resolveCheck(fixture: string, override: string | undefined): string {
  if (override !== undefined) return override;
  const script = join(fixture, "check.sh");
  return existsSync(script) ? `bash ${JSON.stringify(script)}` : "node --test";
}

function dumpRun(
  name: string,
  result: AgentResult,
  turns: CapturedTurn[],
  check: CheckOutcome,
): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  // A unique suffix keeps parallel runs (and repeats) from colliding on the same
  // millisecond and overwriting each other's trace.
  const uniq = Math.random().toString(36).slice(2, 8);
  const dir = join(RUNS, `live-${ts}-${name}-${uniq}`);
  mkdirSync(dir, { recursive: true });
  // The run's verdict: without it a trace only shows the trajectory, not whether the task
  // was actually solved (docs/testing_ru.md §3).
  writeFileSync(
    join(dir, "run.json"),
    JSON.stringify(
      { name, done: result.done, stopReason: result.stopReason, turns: result.turns, check },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dir, "contexts.ndjson"),
    turns
      .map((turn) =>
        JSON.stringify({
          turn: turn.turn,
          chars: turn.contextChars,
          action: turn.action,
          context: turn.context,
        }),
      )
      .join("\n"),
  );
  writeFileSync(join(dir, "events.ndjson"), result.events.map((event) => JSON.stringify(event)).join("\n"));
  writeFileSync(
    join(dir, "proposals.ndjson"),
    turns.map((turn) => JSON.stringify({ turn: turn.turn, action: turn.action })).join("\n"),
  );

  // Tape telemetry (docs/testing_ru.md §3): the context is the message tape, so an offline
  // analyser reads its length, per-turn tool-message volume and the ids the model queried.
  const requested = turns.map((turn) =>
    turn.action.operator === "recall"
      ? [turn.action.id]
      : turn.action.operator === "search"
        ? [turn.action.id]
        : [],
  );
  const toolChars = (context: Context): number =>
    context.history.filter((message) => message.role === "tool").reduce((sum, message) => sum + message.text.length, 0);
  writeFileSync(
    join(dir, "workset.ndjson"),
    turns
      .map((turn, index) =>
        JSON.stringify({
          turn: turn.turn,
          historyCount: turn.context.history.length,
          toolChars: toolChars(turn.context),
          requested: requested[index] ?? [],
        }),
      )
      .join("\n"),
  );
  writeFileSync(
    join(dir, "workset.json"),
    JSON.stringify(
      {
        peakHistory: Math.max(0, ...turns.map((turn) => turn.context.history.length)),
        peakToolChars: Math.max(0, ...turns.map((turn) => toolChars(turn.context))),
      },
      null,
      2,
    ),
  );
  return dir;
}

export async function runScenario(name: string, options: RunOptions = {}): Promise<ScenarioRun> {
  const settings = loadSettings();
  const fixture = join(FIXTURES, name);
  if (!existsSync(join(fixture, "repo"))) throw new Error(`no repo in ${fixture}`);
  const request = readFileSync(join(fixture, "request.txt"), "utf8").trim();
  const constraints = options.constraints ?? readConstraints(fixture);

  const root = mkdtempSync(join(tmpdir(), `skein-scn-${name}-`));
  cpSync(join(fixture, "repo"), root, { recursive: true });
  const before = snapshotDir(root);

  const model = createChatModel(settings);
  const turns: CapturedTurn[] = [];
  const propose = async (context: Context): Promise<Proposal> => {
    const contextChars = promptText(context).length;
    const proposal = await invokeTools(model, buildMessages(context));
    turns.push({
      turn: turns.length,
      action: proposal.action,
      contextChars,
      context,
    });
    return proposal;
  };

  const checkCommand = resolveCheck(fixture, options.check);

  const result = await runAgent(
    { propose, workspace: fsWorkspace(root), maxTurns: options.maxTurns ?? settings.maxTurns },
    {
      request: { id: "r1", text: request },
      ...(constraints.length > 0 ? { constraints } : {}),
    },
  );

  const check = spawnSync("bash", ["-c", checkCommand], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
  });
  const outcome: CheckOutcome = {
    code: check.status ?? -1,
    stdout: check.stdout ?? "",
    stderr: check.stderr ?? "",
  };

  dumpRun(name, result, turns, outcome);

  return {
    name,
    result,
    root,
    before,
    turns,
    check: outcome,
  };
}

export type Branch =
  | "recall"
  | "search"
  | "grep"
  | "list"
  | "read"
  | "edit"
  | "write"
  | "run"
  | "fetch"
  | "apply_patch"
  | "revise"
  | "create_goal";

export function branchesOf(turns: readonly CapturedTurn[]): Set<Branch> {
  const used = new Set<Branch>();
  for (const { action } of turns) {
    switch (action.operator) {
      case "recall":
        used.add("recall");
        break;
      case "search":
        used.add("search");
        break;
      case "create_goal":
        used.add("create_goal");
        break;
      case "apply":
        used.add(action.action.tool);
        break;
    }
  }
  return used;
}

export function repeatsOf(events: readonly Event[]): string[] {
  // Anti-thrash metric: distinct already-known results the model tried to re-access,
  // not the number of refusal events (a stubborn model may retry the same id several
  // times). The refusal reason names the id.
  const keys = new Set<string>();
  for (const event of events) {
    if (event.type !== "record_rejection" || !event.reason.startsWith("repeated_action")) continue;
    keys.add(event.reason.match(/([a-z]+:\d+)/)?.[1] ?? event.reason);
  }
  return [...keys];
}

export function mutationsOf(events: readonly Event[]): string[] {
  return events.filter((event) => event.type === "mutate").map((event) => (event.type === "mutate" ? event.ref : ""));
}

// Goal criterion runs: an observation with a `target` and an exit code. Used to tell
// whether a run recovered from a refuted fix (a real programmer keeps trying;
// docs/testing_ru.md §3).
export function checksOf(events: readonly Event[]): { command: string; verdict: string }[] {
  const out: { command: string; verdict: string }[] = [];
  for (const event of events) {
    if (event.type !== "add_node" || event.node.kind !== "observation") continue;
    const payload = event.node.payload as
      | { command?: unknown; target?: unknown; exitCode?: unknown }
      | undefined;
    if (typeof payload?.target !== "string" || typeof payload?.command !== "string") continue;
    if (typeof payload.exitCode !== "number") continue;
    out.push({ command: payload.command, verdict: payload.exitCode === 0 ? "pass" : "fail" });
  }
  return out;
}

export function refutedChecks(events: readonly Event[]): string[] {
  return checksOf(events)
    .filter((check) => check.verdict === "fail")
    .map((check) => check.command);
}
