# Skein — system prompt: behavior and blocks

> Russian mirror — `docs/system_prompt_ru.md`.

Related: `docs/ir_semantics.md` (IR semantics: the prompt is the doxa's policy over it),
`docs/tools.md` (tool contract), `docs/projection.md` (what the model sees),
`docs/plans/archive/system_prompt_revision_plan.md` (revision plan and phases),
`src/loop/prompt/` (assembly), `tests/prompt.test.ts` (L1 tests).

This is the **source of truth about prompt behavior**. The code follows it: a behavior
change goes "edit here → edit the block → test".

## 0. Principle

The prompt is an **operational spec of the doxa's policy**, not a paragraph of text. It is
made of **blocks**, and one block is responsible for **one behavior**. A block's behavior
is checked at three levels:

- **L1 — static contract** (`tests/prompt.test.ts`, offline, CI): structure, tool names,
  required phrasings;
- **L2 — fixture scenarios** (under `SKEIN_LIVE=true`): trajectory shape on a fixture;
- **L3 — acceptance/bench**: real tasks, including the controlled experiment.

Honestly: L2–L3 depend on LLM non-determinism and are therefore weak; L1 is mandatory,
L2 is under the gate, L3 is acceptance.

## 1. Assembly model

- The prompt is assembled in `src/loop/prompt/index.ts` from `PROMPT_BLOCKS`
  (`src/loop/prompt/blocks.ts`): `SYSTEM_PROMPT = PROMPT_BLOCKS.map(b => b.text).join("\n\n")`.
- A block is `{ id: string; text: string }`; the IDs are stable (B1…).
- `src/loop/propose.ts` re-exports `SYSTEM_PROMPT` (keeps the tests' import path).
- The technical tool contract is **generated from the registry** `PROPOSAL_TOOLS`
  (`src/llm/tools.ts`), not copied into the text (Phase 2).

**Assembly invariants:**

1. one block = one behavior; no duplication between blocks;
2. every behavior has an ID and a §2 entry;
3. the assembled prompt equals the concatenation of blocks (checked by L1);
4. the tool names match the registry (checked by L1).

## 2. Blocks

| ID | Behavior | Basis | Status |
|---|---|---|---|
| B1 | Frame: the doxa proposes exactly one operator, the logos decides; the context is a projection, not a dialogue | `ir_semantics` §1, §7 | in code |
| B2 | Capabilities from `FRAGMENT`; anything else is outside the fragment | `src/ir/fragment.ts` | in code |
| B3 | Tree vocabulary: `request`/`goal`(`what`/`why`/`sketch`)/`plan`/`action`/`observation`/`stop`; a request is interpreted exactly once (`has_goal`) or declined (`unactionable`/`decline`); a goal is closed only by `stop` (no criterion) | `ir_semantics` §2, §2.6 | in code |
| B4 | Reading the projection: `path`/`constraints`/`lastResult`/`calls`/`shown`/`applicable`/`budget`; the current item is the last in its container (no `chosen`) | `src/ir/project.ts` | in code |
| B5 | Memory and working set: `shown`, `query {id}`, "no knowledge outside the context" | `tools` §4.4–4.5 | in code |
| B6 | Goal from the request: literal commands verbatim, workspace root, `cd <dir> &&`, do not guess a command | `tools` §5.1 | in code |
| B7 | Decomposition: `sketch` string + first `command`; one command per turn; the current item is the last in a container (no `chosen`); a sub-goal only as an alternative; no separate verify; prepare/build the tree before reading a failure as the defect, and run that build/test in the foreground | `ir_semantics` §4.1, `tools` §4.7 | in code |
| B8 | VCS/history policy: git is fine when present; do not retry a failed git | this doc, §4 | in code (revised) |
| B9 | External reference / differential localization; a reference diff is a lead, not a checklist | this doc, §4 | in code |
| B10 | Failure → cause: log → location; distinguish a wrong working directory (missing source path) from an unbuilt/unconfigured tree (setup); read symbol/macro definitions | `tools` §5 | in code |
| B11 | Revision loop: a failed command = progress; branch the current item (sub-goal or a different command); the new `what` must state a DIFFERENT hypothesis | `ir_semantics` §4.1 | in code |
| B12 | Tool contract: flat names, including `decline`, generated from `PROPOSAL_TOOLS` | `src/llm/tools.ts` | in code (generated) |
| B13 | Output discipline: `thought` ≤1 sentence, exactly one call | `tests/prompt.test.ts` | in code |
| B14 | Stream discipline: no `2>&1`/`&>`, no pipe through `tail`/`head` | `tools` §4.3 | in code (B14) |
| B15 | Stop: `stop` finishes the focused goal — appends a `stop` node as its last plan item + a `has_stopped` edge; there is no criterion gate; there is no `stop` on the request | `ir_semantics` §4.3, §6 | in code (B15) |
| B16 | Constraints/safety: never violate a `constraint`, never edit on a stale read; once localized, edit — not more reading | `ir_semantics` §9 | in code (trimmed) |

### Per-block detail

- **B1** sets the role: the doxa only proposes; refusals and tool failures are the only
  facts the engine adds, and the projection is not a dialogue.
- **B2** lists `FRAGMENT` (inspect/modify/execute/verify/abduce).
- **B3** introduces the node vocabulary; there is no separate
  `claim`/`decision` kind. It names the node kinds a turn can add — a command (apply), a
  goal (create_goal), stop, decline — so every accepted turn adds exactly one node. A
  request is interpreted exactly once (a `has_goal` edge) or declined (`unactionable`); the
  interpretation is FIXED. A goal carries `what`/`why?`/`sketch`, its plan is seeded with
  the first `command`, and it is closed only by `stop` (there is no criterion).
- **B4** describes the `Context` fields the model sees; in any container the current item
  is the last one added (there is no `chosen` edge). When only `create_goal`/`decline` is
  offered (focus is a fresh request), the request has not been interpreted yet.
- **B5** fixes: the working set is engine-owned; `query {id}` is the only entry point.
- **B6** forbids guessing a command; the first command is literal, from the workspace
  root, with a `cd <dir> &&` prefix in a subdirectory. **Command rule:** if the request
  mentions any command that verifies the work, the interpretation's `command` MUST be
  that literal command. The same rule is stated in the `create_goal` tool `description`
  (B12) — the schema the model sees on every call (Phase 9).
- **B7** fixes decomposition: every `create_goal` carries a `sketch` (a free-form string
  note) and a `command` — the first concrete plan item. The engine does NOT auto-run the
  plan; you work one command per turn and choose the next from its result. Every accepted
  turn adds exactly one node — a command (apply), a goal (create_goal), stop, or decline.
  The current item in a container is the last one added (there is no `chosen` edge). A
  sub-goal is allowed only as an **alternative** to the current item (decompose it), never
  as a plan item and never mandatory. The repair routine **prepares the tree first**: a
  run usually has a BUILD prerequisite, and a failure from an unbuilt/unconfigured tree
  is SETUP, not the defect — read the project's own build docs (README/HACKING/INSTALL) and
  build (e.g. `./configure && make`) before localizing. Run that build (and any test suite)
  in the FOREGROUND: it blocks until it finishes (one turn for the whole command). A goal is
  finished only by `stop`, which appends a `stop` node as the goal's last plan item and a
  `has_stopped` edge. There is no `stop` on the request — the request/run ends when its goal
  is stopped. Nothing closes a chain of ancestors.
- **B8** (revised in Phase 3): git/history is a normal tool when present; this workspace
  may have no `.git`, and a failed history command must not be retried or probed in other
  roots; local history and an external reference are different things.
- **B9** (Phases 3–4): if an artifact has a canonical reference (upstream, a published
  version, a sibling/backup copy), obtaining it and diffing is legitimate and often the
  fastest localization. An external reference is fetched with `fetch { url, path? }` (or
  `curl` through `run`) as read-only evidence; an upstream change is applied with
  `apply_patch`. In IR: an artifact `file`; the diff is an observation. A reference diff is
  a **lead, not a checklist**: the upstream may carry many unrelated deltas, so it names a
  suspect to hunt, not a list of hunks to reconcile.
- **B10** sets the log-to-location move and separates the two causes of "not found": a
  missing SOURCE path (the suite/entry directory is absent → wrong working directory →
  `cd <dir> &&`) from a missing BUILD OUTPUT the project generates (`Makefile.config`/
  `config.status`/a compiled binary → the tree is not configured/built → run the project's
  build; setup, not the defect).
- **B11** sets the behavior on failure: a failed command is progress, not a dead end.
  The next move branches the current item — a sub-goal (create_goal) or a different
  command (apply, the item's newest alternative) — and the new `what` must state a
  DIFFERENT hypothesis (`ir_semantics` §4.1).
- **B12** lists the tools; it is generated from `PROPOSAL_TOOLS`, so drift (e.g. a
  non-existent `apply`) is impossible.
- **B13** bounds `thought`.
- **B14** forbids `2>&1`/`&>` and pipes through `tail`/`head`.
- **B15** finishes a goal: the doxa proposes `stop` and the engine appends a `stop` node as
  the goal's last plan item and a `has_stopped` edge — there is no criterion gate; it then
  returns to the request and the run ends. There is no `stop` on the request — it ends when
  its goal is stopped.
- **B16** is trimmed to unique safety rules (constraints, stale read, "suspect → edit",
  explanatory gap); the duplicates moved to B6/B7/B11/B14/B15 and to the tool
  `description`s. It states the **localized** trigger: once the doxa can point at the exact
  expression to change, the only advance is `edit` (or a check that refutes it) — not more
  reading.

## 3. Cross-cutting invariants

1. no contradictions between blocks (checked by review and L1 phrasings);
2. every registry tool is named callably (L1, Phase 2);
3. the prompt's character budget is an **open question** (§6): no target is fixed and no
   test enforces one.

## 4. What changed

- **Phase 1 (2026-10-07).** The text was moved into blocks without a behavior change; the
  `src/loop/prompt/` structure was assembled; an L1 assembly test was added. The texts are
  preserved verbatim (comparison with `HEAD` by normalized whitespace is identical; only
  the paragraph separators differ).
- **Phase 2 (2026-10-07).** B12 is generated from `PROPOSAL_TOOLS` (the `apply` drift is
  removed); the tool contract and arguments moved into the `description`s
  (`src/llm/tools.ts`); B14 and B15 are extracted from "Rules" into their own blocks; B16
  is trimmed to unique rules. Prompt: 20,338 → 17,718 characters.
- **Phase 3 (2026-10-07).** B8 is rewritten (git is fine when history exists; a failed git
  is not retried; local history ≠ an external reference); B9 is added (external reference
  and diff localization); the anti-git line is removed from B7 (the policy lives in B8).
  L2 fixtures: `reference-diff` (a reference snapshot → expect a `diff`) and `no-vcs` (no
  `.git` → no repeated git).
- **Phase 4 (2026-10-07).** Added the `fetch` tool (URL → workspace, read-only reference)
  and `apply_patch` (unified diff); `read`/`edit`/`write` no longer crash the run on a path
  outside the workspace — a refusal is recorded (like `grep`/`list`).
- **Phase 5 (2026-10-08).** B3/B4/B11 and the `create_goal` description now state that the
  request's `alternatives` is the history of interpretations and that a `what` equal to a
  refuted option's label is refused `repeat_hypothesis`, even with `revises` (a live run
  re-proposed a refuted interpretation because B11 only spoke of the current goal).
- **Phase 6 (2026-10-09).** B7's repair routine gained the prepare/build step and B10 split
  its single "not found = wrong directory" rule into wrong directory (missing source path)
  vs unbuilt/unconfigured tree (missing build output → run the project's build; setup, not
  the defect). A live `fix-ocaml-gc` run applied the correct edit but read
  `No rule to make target '../Makefile.build_config'` as a directory error and never ran
  `./configure && make`, so its own criterion never passed (reward 1 only via the verifier's
  clean rebuild).
- **Phase 7 (2026-10-09).** B7/B16 add the **named-suspect trigger**: once the exact
  expression to change is named, the next action is `edit` — not more reading; B9 calls a
  reference diff a **lead, not a checklist** (a moved-upstream diff carries many unrelated
  deltas, so hunt the one invariant-breaking change). Engine: `invokeTools` no longer
  doubles the completion cap on a truncation — one brevity retry at the ceiling (a live
  transcript run turned one `read` into 4 calls / 60.9k completion tokens).
- **Phase 8 (2026-10-09).** The `run` description and B7 now say a build/test is run in the
  **foreground** (it blocks, one turn for the whole command) and that `background` is for
  non-terminating commands only. Engine (`workspace.ts`): `startJob` gives a job a short
  grace before handing back a handle, and `pollJob` waits for the job (up to the cap) instead
  of returning `running` at once — the shell writes its `$?` to `.skein/jobs/<id>.code` so
  the synchronous wait sees completion. A live `fix-ocaml-gc` run backgrounded three builds
  and spent 16 of 60 turns polling them (≈25% of the cost); a foreground run of the same
  builds finishes in one turn each (docs/tools.md §4.7).
- **Phase 9 (2026-10-09).** The workspace-root/`cd <dir> &&` rule moved into the
  `create_goal` tool `description` (B6 already had it, but the tool schema is what the model
  attends to most). A live `fix-ocaml-gc` run interpreted the request — which named `ocaml/`
  and the bare `make -C testsuite one DIR=tests/basic` — with the bare command and only
  revised it late, turning most of the run into criterion churn. B7's interpretation bullet
  also gained the caveat. New live test `tests/live/root-cd.test.ts` (one call per layout).
- **Phase 10 (2026-10-09).** Goal reduction (`docs/plans/goal_reduction_plan.md`): B3/B4/B6/
  B7/B11/B15 lose the criterion vocabulary. A goal is `what`/`why`/`sketch` with a plan
  seeded by the first `command`; `stop` closes it with no criterion gate; `revises`/
  `repeat_hypothesis`/`check_not_run`/`checkReady`/`nextAction`/`state` are gone. The
  `create_goal` and `run` tool `description`s are rewritten accordingly (`run` is one plain
  foreground command — no `target`/`background`/`job`).

## 5. Test map

| Level | Where | What it checks |
|---|---|---|
| L1 | `tests/prompt.test.ts` | assembly from blocks; unique IDs; stream discipline; workspace root (prompt + `create_goal` description); wrong-directory reaction; setup (unbuilt tree) vs wrong directory |
| L1 (Phase 2) | `tests/prompt.test.ts` | every `PROPOSAL_TOOLS` tool is named; no `apply {`/`{ tool:` |
| L2 | `tests/live/scenarios.test.ts` | trajectory shape on a fixture (B7/B8/B9/B10/B11/B15) |
| L3 | `bench/`, `docs/benches/bench_report.md` | acceptance; the controlled experiment (Phase 5) |

## 6. Open questions

- The target character budget for the prompt and what to move into tool `description`s.
- How strict B6/B7 should be (how much to dictate order vs leave flexibility).
- B9 is implemented: `fetch` for an external reference (Phase 4); `curl` through `run`
  also works.
