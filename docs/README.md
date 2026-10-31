# Skein — documentation

Start here. This is the index of the documentation; every document exists in English
and Russian, the Russian version in a file with the `_ru` suffix.

> Русские зеркала — файлы с суффиксом `_ru` рядом с каждым документом.

## What Skein is

- [concepts.md](concepts.md) · [RU](concepts_ru.md) — the conceptual overview: doxa/logos,
  the IR, the projection.
- [logos_ir.md](logos_ir.md) · [RU](logos_ir_ru.md) — the doxa/logos frame in depth.
- [design_review.md](design_review.md) · [RU](design_review_ru.md) — design review notes.

## Sessions and controllability

- [controllability.md](controllability.md) · [RU](controllability_ru.md) — triggers emitted by
  the engine and the RequestObserver that decides what to do; the trigger and tool inventory is
  open (4a core implemented; see `plans/request_observer_plan`). Tier 4, first.
- [session_concepts.md](session_concepts.md) · [RU](session_concepts_ru.md) — sessions: why
  continuity is needed, the container of units, the session agent, its memory tools, the
  hierarchical outline, and task isolation (implemented; verified offline and live; see `plans/session_agent_plan`
  and `plans/session_driver_plan`). Tier 4, second.

## The IR (the engine's source of truth)

- [ir.md](ir.md) · [RU](ir_ru.md) — the IR as built: operations, state, control.
- [ir_semantics.md](ir_semantics.md) · [RU](ir_semantics_ru.md) — the source of truth for the
  shape, the doxa's operators and the context (folded from the revision).
- [walkthrough.md](walkthrough.md) · [RU](walkthrough_ru.md) — the end-to-end example: states
  and the dynamic tape across execution contexts (a fix, a revision, a give-up, a decomposed
  step, a non-decisive run, the world).
- [ir_operations.md](ir_operations.md) · [RU](ir_operations_ru.md) — the operator registry
  (`OP-MV`, `OP-CG`, `OP-AP`, `TR`, `DER`, `REF`, ...). The coverage gate reads this file; keep
  the ids in sync with the tests.
- [projection.md](projection.md) · [RU](projection_ru.md) — the context projection: what the
  model sees each turn and why.
- [tools.md](tools.md) · [RU](tools_ru.md) — the tool contract.

## The model surface

- [system_prompt.md](system_prompt.md) · [RU](system_prompt_ru.md) — the behavior blocks the
  system prompt is assembled from.
- [prompt_state_machine_concept.md](prompt_state_machine_concept.md) ·
  [RU](prompt_state_machine_concept_ru.md) — the agent's prompt as a state machine (states,
  criteria, transitions, constraints); draft.
- [states_ru.md](states_ru.md) — the states' goals and acceptance criteria (RU-only draft).
- [state_testing.md](state_testing.md) · [RU](state_testing_ru.md) — testing the state prompts
  step by step on a live task: the container, `bench/live-step.ts`, the tape per situation,
  results and open problems.
- [live_step.md](live_step.md) · [RU](live_step_ru.md) — the real engine one turn at a time
  (`bench/live-step.ts`): a long-lived container, `seed`/`startTurn`, per-turn tape, results and
  tree diff.
- [context_design.md](context_design.md) · [RU](context_design_ru.md) — the design rationale
  for the projection (working memory, alternatives).

## Working on the engine

- [testing.md](testing.md) · [RU](testing_ru.md) — how to run tests and benches and where the
  output lands.
- [task_testing.md](task_testing.md) · [RU](task_testing_ru.md) — testing on real tasks: the
  sandbox (Docker/bwrap), Harbor, the step-by-step `bench/live-step.ts`, and the fast
  `bench/turn.ts` probe.
- [plans/implementation_plan.md](plans/implementation_plan.md) · [RU](plans/implementation_plan_ru.md)
  — overall plan, decisions, roadmap, status.

## Plans

- `plans/` — active plans (`implementation_plan`).
- [plans/request_observer_plan.md](plans/request_observer_plan.md) ·
  [RU](plans/request_observer_plan_ru.md) — Tier 4a: triggers, the observer unit, `hint`/`memo`/`halt`,
  and the minimal session shell (draft for approval).
- [plans/session_agent_plan.md](plans/session_agent_plan.md) ·
  [RU](plans/session_agent_plan_ru.md) — Tier 4b (first slice): attention statuses, the L0/L1
  outline, the session unit and `SessionAgent`, and the operations `respond`/`start`
  (implemented; other operations deferred).
- [plans/session_driver_plan.md](plans/session_driver_plan.md) ·
  [RU](plans/session_driver_plan_ru.md) — Tier 4b: the terminal REPL, its driver,
  `respond`/`start`, task isolation, request reformulation and the utterance ordinal
  (implemented; verified offline and with the live synthetic session).
- [plans/session_interrupt_plan.md](plans/session_interrupt_plan.md) ·
  [RU](plans/session_interrupt_plan_ru.md) — Tier 4c: pause/resume/cancel uniformly for the
  session agent, the task agent and the observer, plus the telemetry contract for the future
  status panel (implemented; verified offline).
- [plans/ai_sdk_migration_plan.md](plans/ai_sdk_migration_plan.md) ·
  [RU](plans/ai_sdk_migration_plan_ru.md) — migrate the model layer to the Vercel AI SDK,
  keeping LangGraph and the IR (proposed).
- `plans/archive/` — completed or superseded plans, kept for the record.
- [plans/archive/state_protocol_plan.md](plans/archive/state_protocol_plan.md) ·
  [RU](plans/archive/state_protocol_plan_ru.md) — the state protocol redesign: states as the
  walk's skeleton, `move { state, what }` (a state IS its goal), a flat plan, a forced
  transition on `stop`, a terminal state (done; extended by goal-into-move).
- [plans/archive/goal_into_move_plan.md](plans/archive/goal_into_move_plan.md) ·
  [RU](plans/archive/goal_into_move_plan_ru.md) — the goal moves into `move` (done; the tape
  renders a state as `Start state` / instruction / goal / `Finish state` markers).
- [plans/archive/state_transitions_plan.md](plans/archive/state_transitions_plan.md) ·
  [RU](plans/archive/state_transitions_plan_ru.md) — the state's goal as the state-change move
  (superseded by the state protocol).
- [plans/archive/goal_reduction_plan.md](plans/archive/goal_reduction_plan.md) ·
  [RU](plans/archive/goal_reduction_plan_ru.md) — reduce the goal to its minimal, monotone shape (done).
- [plans/archive/step_reduction_plan.md](plans/archive/step_reduction_plan.md) ·
  [RU](plans/archive/step_reduction_plan_ru.md) — context format and LLM-turn reduction (done).
- [plans/archive/traversal_stack_spec.md](plans/archive/traversal_stack_spec.md) ·
  [RU](plans/archive/traversal_stack_spec_ru.md) — the traversal stack (the spine and the arms) (done).
- [plans/archive/ir_revision_implementation_plan.md](plans/archive/ir_revision_implementation_plan.md) ·
  [RU](plans/archive/ir_revision_implementation_plan_ru.md) — the IR revision rollout (done; the
  spec was folded into `ir_semantics`).
- [plans/archive/observation_plan.md](plans/archive/observation_plan.md) ·
  [RU](plans/archive/observation_plan_ru.md) — observation of changes outside the engine (done).
- [plans/archive/stop_closure_plan.md](plans/archive/stop_closure_plan.md) · [RU](plans/archive/stop_closure_plan_ru.md)
  — one closure (`stop`), checks as observations, no arbiter (done).
- [plans/archive/request_goal_plan.md](plans/archive/request_goal_plan.md) · [RU](plans/archive/request_goal_plan_ru.md)
  — one interpretation per request, `unactionable`, `stop` inside the plan, no `chosen`
  (done; superseded by the state / `move` model).
- [plans/archive/logos_roadmap_plan.md](plans/archive/logos_roadmap_plan.md) · [RU](plans/archive/logos_roadmap_plan_ru.md)
  — the earlier logos roadmap (modes, `cited`, `Revision`); superseded by the IR
  semantics, kept as history.

## Benchmarks and reports

- [benches/best_bench.md](benches/best_bench.md) · [RU](benches/best_bench_ru.md) — the
  leaderboard of the best runs (top-10; currently `fix-ocaml-gc`).
- [benches/bench_report.md](benches/bench_report.md) · [RU](benches/bench_report_ru.md) — Skein
  vs opencode: metrics, caveats, the controlled `ref-localize` experiment.
- [benches/compare_skein_opencode.md](benches/compare_skein_opencode.md) ·
  [RU](benches/compare_skein_opencode_ru.md) — the per-task matrix comparison of Skein and
  opencode (`tests/sandbox/matrix.ts`): one section per task, tokens as the primary axis.
- [benches/task_benchmarks.md](benches/task_benchmarks.md) ·
  [RU](benches/task_benchmarks_ru.md) — per-task benchmark pages for the article: what each
  task is, how it is solved, and the Skein vs opencode results (`net on`/`off`); filled one
  task at a time.
- [benches/fix_ocaml_gc_ideal.md](benches/fix_ocaml_gc_ideal.md) · [RU](benches/fix_ocaml_gc_ideal_ru.md)
  — the reference trajectory (the model instance).
- [benches/fix_ocaml_gc_investigation.md](benches/fix_ocaml_gc_investigation.md) ·
  [RU](benches/fix_ocaml_gc_investigation_ru.md) — the `fix-ocaml-gc` run journal.
- [benches/fix_ocaml_gc_run_report.md](benches/fix_ocaml_gc_run_report.md) and the dated
  `benches/fix_ocaml_gc_run_report_2026-10-*.md` runs · [RU](benches/fix_ocaml_gc_run_report_ru.md).
- [benches/engine_fixes_found.md](benches/engine_fixes_found.md) · [RU](benches/engine_fixes_found_ru.md)
  — the engine fixes the investigation produced.
