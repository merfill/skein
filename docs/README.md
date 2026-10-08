# Skein — documentation

Start here. This is the index of the documentation; every document has an English
original and a Russian mirror named with the `_ru` suffix.

> Русские зеркала — файлы с суффиксом `_ru` рядом с каждым документом.

## What Skein is

- [concepts.md](concepts.md) · [RU](concepts_ru.md) — the conceptual overview: doxa/logos,
  the IR, the projection.
- [logos_ir.md](logos_ir.md) · [RU](logos_ir_ru.md) — the doxa/logos frame in depth.
- [design_review.md](design_review.md) · [RU](design_review_ru.md) — design review notes.

## The IR (the engine's source of truth)

- [ir.md](ir.md) · [RU](ir_ru.md) — the IR as built: operations, state, control.
- [ir_semantics.md](ir_semantics.md) · [RU](ir_semantics_ru.md) — the semantics of the tree
  and the doxa's operators (spine/arms, state, invariants).
- [ir_operations.md](ir_operations.md) · [RU](ir_operations_ru.md) — the operator registry
  (`OP-CG`, `OP-AP`, `TR`, `DER`, `REF`, ...). The coverage gate reads this file; keep the
  ids in sync with the tests.
- [projection.md](projection.md) · [RU](projection_ru.md) — the context projection: what the
  model sees each turn and why.
- [tools.md](tools.md) · [RU](tools_ru.md) — the tool contract.

## The model surface

- [system_prompt.md](system_prompt.md) · [RU](system_prompt_ru.md) — the behavior blocks the
  system prompt is assembled from.
- [context_design.md](context_design.md) · [RU](context_design_ru.md) — the design rationale
  for the projection (working memory, working set, alternatives).

## Working on the engine

- [testing.md](testing.md) · [RU](testing_ru.md) — how to run tests and benches and where the
  output lands.
- [plans/implementation_plan.md](plans/implementation_plan.md) · [RU](plans/implementation_plan_ru.md)
  — overall plan, decisions, roadmap, status.
- [plans/traversal_stack_spec.md](plans/traversal_stack_spec.md) · [RU](plans/traversal_stack_spec_ru.md)
  — the traversal stack (the spine and the arms).
- [plans/step_reduction_plan.md](plans/step_reduction_plan.md) · [RU](plans/step_reduction_plan_ru.md)
  — context format and LLM-turn reduction (current work).
- [plans/observation_plan.md](plans/observation_plan.md) · [RU](plans/observation_plan_ru.md)
  — observation of changes outside the engine (a/b done, c open).

## Plans

- `plans/` — active plans.
- `plans/archive/` — completed or superseded plans, kept for the record.
- [plans/archive/logos_roadmap_plan.md](plans/archive/logos_roadmap_plan.md) · [RU](plans/archive/logos_roadmap_plan_ru.md)
  — the earlier logos roadmap (modes, `cited`, `Revision`); superseded by the IR
  semantics, kept as history.

## Benchmarks and reports

- [benches/bench_report.md](benches/bench_report.md) · [RU](benches/bench_report_ru.md) — Skein
  vs opencode: metrics, caveats, the controlled `ref-localize` experiment.
- [benches/fix_ocaml_gc_ideal.md](benches/fix_ocaml_gc_ideal.md) · [RU](benches/fix_ocaml_gc_ideal_ru.md)
  — the reference trajectory (the model instance).
- [benches/fix_ocaml_gc_investigation.md](benches/fix_ocaml_gc_investigation.md) ·
  [RU](benches/fix_ocaml_gc_investigation_ru.md) — the `fix-ocaml-gc` run journal.
- [benches/fix_ocaml_gc_run_report.md](benches/fix_ocaml_gc_run_report.md) and the dated
  `benches/fix_ocaml_gc_run_report_2026-10-*.md` runs · [RU](benches/fix_ocaml_gc_run_report_ru.md).
- [benches/engine_fixes_found.md](benches/engine_fixes_found.md) · [RU](benches/engine_fixes_found_ru.md)
  — the engine fixes the investigation produced.
