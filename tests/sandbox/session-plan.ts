import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadSettings } from "../../src/config/settings";
import type { Event } from "../../src/ir/events";
import type { Context } from "../../src/ir/project";
import { createChatModel } from "../../src/llm/client";
import { modelDocumentPlanAgent, modelDocumentTextAgent } from "../../src/llm/document";
import { modelGeneralProposer } from "../../src/llm/general";
import { modelPlannerAgent } from "../../src/llm/planner";
import { modelRevisionProposer } from "../../src/llm/revision";
import { propose as proposeModel } from "../../src/loop/propose";
import { probeSession } from "../../src/loop/probe";
import {
  executePlan,
  runSessionTurn,
  type SessionTurnDeps,
} from "../../src/session/driver";
import { createSession } from "../../src/session/session";
import { createSessionAgentDeps } from "../../src/llm/session_agent";
import type { SessionAgent } from "../../src/session/session_agent";
import { memoryTelemetry, usageTotals } from "../../src/session/telemetry";
import { renderPlanDraft, renderPlanRun } from "../../src/session/view";
import type { Action, Proposals } from "../../src/llm/schemas";
import { cleanupContainers } from "./docker";
import {
  openTaskWorkspace,
  verifyOpenedTask,
  type OpenedTask,
  type TaskVerification,
} from "./harness";
import { parseNetworkMode, type NetworkMode } from "./network";
import type { SandboxTask } from "./task";
import { TASKS } from "./tasks/registry";
import { FIX_OCAML_REQUEST, fixOcamlGc } from "./specs/fix-ocaml-gc";
import { sandboxWorkspace, cleanupSandboxes, type SandboxSpec } from "./workspace";

// A session-level plan run on a real task (or the virtual fix-ocaml-gc spec):
//   SKEIN_LIVE=true npx tsx tests/sandbox/session-plan.ts fix-ocaml-gc --virtual --turns 20
//   SKEIN_LIVE=true npx tsx tests/sandbox/session-plan.ts custom-memory-heap-crash --turns 80
//
// The first interpretation is forced to `plan` (the harness tests the plan driver, not the
// session agent's route choice; the route is covered offline). Then `executePlan` walks the
// items with the real session agent, the task/general agents and the task's own verifier.
// `--fail-first-item` forces the first item's first attempt to end `no_decision`, so the
// driver's retry path runs against the real model (the plan must still finish).
// Run only with the owner's go-ahead; it costs model calls (and Docker for a real task).

const settings = loadSettings();
const model = createChatModel(settings);

interface Options {
  id: string;
  virtual: boolean;
  maxTurns?: number;
  network: NetworkMode;
  dir?: string;
  failFirstItem: boolean;
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

function optionsOf(): Options {
  const id = process.argv[2]?.startsWith("--") === false ? (process.argv[2] as string) : "fix-ocaml-gc";
  const turns = arg("--turns", "");
  const dir = arg("--dir", "");
  return {
    id,
    virtual: process.argv.includes("--virtual"),
    ...(turns !== "" ? { maxTurns: Number(turns) } : {}),
    network: parseNetworkMode(arg("--net", "on")),
    ...(dir !== "" ? { dir } : {}),
    failFirstItem: process.argv.includes("--fail-first-item"),
  };
}

function traceDir(id: string, dir: string | undefined): string {
  if (dir !== undefined) {
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  const root = join("bench", "runs", "session-plan");
  mkdirSync(root, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return mkdtempSync(join(root, `${ts}-${id}-`));
}

function short(value: string, limit = 600): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

function lastStop(events: readonly Event[]): string | undefined {
  let text: string | undefined;
  for (const event of events) {
    if (event.type === "add_node" && event.node.kind === "stop") text = event.node.label;
  }
  return text;
}

type ProposerKind = "task" | "general" | "revision";

// `--fail-first-item` is fault injection for the retry path: the first plan item's first
// attempt ends `no_decision` instead of running the real model. `task` needs two empty
// proposals, `general`/`revision` need one. The first proposer call belongs to the first item
// because planning uses the separate planner agent.
function failureInjector(enabled: boolean): (kind: ProposerKind) => boolean {
  let armed = enabled;
  let used = 0;
  return (kind) => {
    if (!armed) return false;
    const limit = kind === "task" ? 2 : 1;
    if (used >= limit) {
      armed = false;
      return false;
    }
    used += 1;
    if (used >= limit) armed = false;
    return true;
  };
}

function proposer(
  capture: ((label: string) => void) | undefined,
  fail: (kind: ProposerKind) => boolean,
) {
  let turn = 0;
  const propose = async (context: Context): Promise<Proposals> => {
    capture?.(`turn-${turn}`);
    const started = Date.now();
    if (fail("task")) {
      console.info(`  [task t${turn}] injected-failure ${Date.now() - started}ms`);
      turn += 1;
      return { thought: "", actions: [] };
    }
    const proposal = await proposeModel(model, context, {
      settings,
      onError: (error) =>
        console.error(`llm call failed: ${error instanceof Error ? error.message : String(error)}`),
    });
    const actions: Action[] =
      proposal.actions.length > 0 ? proposal.actions : [{ operator: "stop", why: proposal.thought }];
    console.info(
      `  [task t${turn}] ${actions.map((a) => (a.operator === "apply" ? a.action.tool : a.operator)).join("+")} ` +
        `${Date.now() - started}ms`,
    );
    turn += 1;
    return proposal;
  };
  return { propose, turns: () => turn };
}

interface RunEnv {
  workspace: SessionTurnDeps["task"]["workspace"];
  request: string;
  task?: SandboxTask;
  opened?: OpenedTask;
  virtualSpec?: SandboxSpec;
}

async function run(id: string, env: RunEnv, options: Options, dir: string): Promise<number> {
  const capture = env.opened?.capture;
  const fail = failureInjector(options.failFirstItem);
  const { propose, turns } = proposer(capture, fail);
  const telemetry = memoryTelemetry();
  const sessionDeps = createSessionAgentDeps(model, { settings });
  const real = sessionDeps.agent;
  // The harness forces the first operation to `plan`; later interpretations (one per item)
  // are the real agent.
  let calls = 0;
  const agent: SessionAgent = async (messages, callOptions) => {
    calls += 1;
    if (calls === 1) {
      return {
        operation: { kind: "plan", text: env.request },
        reasoning: "session-plan harness: force plan mode",
      };
    }
    return real(messages, callOptions);
  };

  const generalBase = modelGeneralProposer(model, { settings });
  const revisionBase = modelRevisionProposer(model, { settings });

  const deps: SessionTurnDeps = {
    sessionAgent: { ...sessionDeps, agent, telemetry: telemetry.sink },
    task: {
      propose,
      workspace: env.workspace,
      maxTurns: options.maxTurns ?? 80,
      probe: (workspace) => probeSession(workspace, { network: options.network }),
      telemetry: telemetry.sink,
    },
    general: {
      propose: async (messages, callOptions) => {
        if (fail("general")) {
          console.info("  [general] injected-failure");
          return { thought: "", actions: [] };
        }
        return generalBase(messages, callOptions);
      },
      workspace: env.workspace,
      maxTurns: settings.generalMaxTurns,
      telemetry: telemetry.sink,
    },
    revision: {
      propose: async (messages, callOptions) => {
        if (fail("revision")) {
          console.info("  [revision] injected-failure");
          return { thought: "", actions: [] };
        }
        return revisionBase(messages, callOptions);
      },
      workspace: env.workspace,
      maxTurns: options.maxTurns ?? settings.maxTurns,
      telemetry: telemetry.sink,
    },
    planGeneralMaxTurns: settings.planGeneralMaxTurns,
    planItemRetries: settings.planItemRetries,
    planner: {
      agent: modelPlannerAgent(model, { settings }),
      workspace: env.workspace,
      maxTurns: settings.plannerMaxTurns,
      telemetry: telemetry.sink,
    },
    document: {
      plan: modelDocumentPlanAgent(model, { settings }),
      write: modelDocumentTextAgent(model, { settings }),
      workspace: env.workspace,
      maxTurns: options.maxTurns ?? settings.maxTurns,
      maxPlanTurns: options.maxTurns ?? settings.plannerMaxTurns,
      telemetry: telemetry.sink,
    },
    telemetry: telemetry.sink,
  };

  const session = createSession();
  console.info(`\n=== ${id}: planning (turns cap ${options.maxTurns ?? 80}) ===`);
  const planned = await runSessionTurn(deps, session, env.request);
  const plan = planned.plan?.result.plan;
  if (planned.plan === undefined || plan === undefined) {
    const unit = planned.plan;
    console.error(
      `no plan produced (operation=${JSON.stringify(planned.operation)}, ` +
        `stopReason=${unit?.result.stopReason ?? "?"}, turns=${unit?.result.turns ?? "?"})`,
    );
    if (unit !== undefined) {
      for (const event of unit.result.events) {
        if (event.type !== "add_node" || event.node.kind !== "action") continue;
        console.info(`  planner action: ${event.node.label}`);
      }
      writeFileSync(
        join(dir, "plan.json"),
        JSON.stringify(
          {
            planUnitId: unit.unitId,
            stopReason: unit.result.stopReason,
            turns: unit.result.turns,
            events: unit.result.events,
            journal: session.units.get(unit.unitId)?.journal ?? [],
          },
          null,
          2,
        ),
      );
    }
    writeFileSync(join(dir, "session.json"), JSON.stringify(session.journal, null, 2));
    return 0;
  }
  console.info(`\nplan ${planned.plan.unitId}:\n${renderPlanDraft(plan)}`);

  console.info(`\n=== ${id}: executing ${plan.items.length} item(s) ===`);
  const run = await executePlan(deps, session, planned.plan.unitId);
  console.info(renderPlanRun(run).join("\n"));

  let verification: TaskVerification | { reward: number; check: { code: number; stdout: string; stderr: string } };
  if (env.virtualSpec !== undefined) {
    const checked = env.workspace.run("make -C testsuite one DIR=tests/basic");
    verification = { reward: checked.code === 0 ? 1 : 0, check: checked };
  } else if (env.opened !== undefined && env.task !== undefined) {
    verification = verifyOpenedTask(env.task, env.opened);
  } else {
    throw new Error("no verification target");
  }

  const usage = usageTotals(telemetry.events);
  const byAgent = Object.fromEntries(
    (["session", "plan", "task", "general", "revision", "document"] as const).map((agent) => {
      const totals = usageTotals(
        telemetry.events.filter((event) => event.type === "model_call" && event.agent === agent),
      );
      return [
        agent,
        {
          calls: totals.calls,
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          reasoningTokens: totals.reasoningTokens,
          cachedInputTokens: totals.cachedInputTokens,
          costRub: totals.cost,
        },
      ];
    }),
  );
  writeFileSync(
    join(dir, "plan.json"),
    JSON.stringify({ planUnitId: planned.plan.unitId, plan, events: planned.plan.result.events }, null, 2),
  );
  writeFileSync(join(dir, "session.json"), JSON.stringify(session.journal, null, 2));
  writeFileSync(
    join(dir, "run.json"),
    JSON.stringify(
      {
        status: run.status,
        completed: run.completed,
        total: run.total,
        units: run.units.map((unit) => ({
          unitId: unit.unitId,
          itemId: unit.itemId,
          kind: unit.kind,
          done: unit.result.done,
          stopReason: unit.result.stopReason,
          answer: lastStop(unit.result.events) ?? null,
        })),
        reply: run.reply ?? null,
        noDecision: run.noDecision ?? null,
        reward: verification.reward,
        check: verification.check,
        taskTurns: turns(),
        // Every model call (session, planner, task, general, revision, document) records its
        // usage on the telemetry sink, so this is the whole session, not just the task pass.
        usage: {
          calls: usage.calls,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          reasoningTokens: usage.reasoningTokens,
          cachedInputTokens: usage.cachedInputTokens,
          costRub: usage.cost,
          byAgent,
        },
      },
      null,
      2,
    ),
  );

  console.info(
    `\n=== ${id}: plan ${run.status} (${run.completed}/${run.total}), reward=${verification.reward}, ` +
      `task turns=${turns()}, in=${usage.inputTokens} out=${usage.outputTokens} ` +
      `rsn=${usage.reasoningTokens} cost=${usage.cost.toFixed(2)}, trace=${dir} ===`,
  );
  if (verification.check.code !== 0) {
    console.info(`check failed (exit ${verification.check.code}): ${short(verification.check.stderr)}`);
  }
  return verification.reward;
}

async function main(): Promise<void> {
  if (process.env.SKEIN_LIVE !== "true") {
    console.error("Set SKEIN_LIVE=true to run a session plan scenario.");
    process.exit(1);
  }
  const options = optionsOf();
  const dir = traceDir(options.id, options.dir);
  let reward = 0;
  try {
    if (options.virtual) {
      const workspace = sandboxWorkspace(fixOcamlGc);
      reward = await run(
        options.id,
        { workspace, request: FIX_OCAML_REQUEST, virtualSpec: fixOcamlGc },
        { ...options, maxTurns: options.maxTurns ?? 20 },
        dir,
      );
    } else {
      const task = TASKS[options.id];
      if (task === undefined) {
        throw new Error(`unknown task ${options.id}; known: ${Object.keys(TASKS).join(", ")}`);
      }
      const opened = openTaskWorkspace(task, { network: options.network });
      reward = await run(
        options.id,
        { workspace: opened.workspace, request: opened.request, opened, task },
        {
          ...options,
          maxTurns: options.maxTurns ?? task.maxTurns ?? 80,
        },
        dir,
      );
    }
  } finally {
    cleanupContainers();
    cleanupSandboxes();
  }
  console.info(`reward=${reward}`);
  process.exitCode = reward === 1 ? 0 : 1;
}

void main();
