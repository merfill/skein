# Changelog

All notable changes to Skein are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-20

### Added

- `task` mode selection: `states` (default) or `hypotheses`, via `--mode`,
  `SKEIN_TASK_MODE`, or `/mode` in the TUI. The mode is stored with the unit of work,
  shown in the header, and used when a paused task resumes.
- Hypothesis mode: `open_hypothesis` with `label`, `claim`, `done` and `follows_from`;
  engine-assigned hierarchical ids (`H1`, `H1.1`); hypothesis and goal closing by text
  (`verdict`/`observed`/`summary`, then `outcome`/`summary`).
- Hypothesis panel: per-hypothesis turns, tokens, time and labels; `tool_call`
  telemetry for the inquiry agent.
- Cap/resume in hypothesis mode: `continue` extends the budget, `finish` writes a
  report, closes open hypotheses as `dropped` and marks the goal `not_achieved`.
- Sandbox and matrix support for `skein-hypotheses` (`--mode`), and live hypothesis
  runs.
- Preprint v2 with the hypothesis mode and its results; site section "Two modes".

### Changed

- The inquiry unit is reachable through `task` with `--mode hypotheses`. `general`,
  `plan` and `write_document` remain states-only.
- The TUI final answer and history read `goal_verdict.summary` as well as `stop`.

### Limitations

- A hypothesis verdict is the model's judgment: the engine records but does not verify
  it. An external verifier remains the arbiter of the result.
- Hypothesis mode costs more turns. A long task needs a larger turn budget; the
  60-turn cap produced false failures, while 80 turns solved `fix-ocaml-gc` 10/10.

## [0.1.0] - 2026-11-13

Initial release: the journal/projection context, explicit states, session units,
`recall`/`search`, npm and Docker packaging, and the K=5 comparative evaluation.
