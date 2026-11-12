# Skein — work states: goals and completion conditions

> Russian mirror — `docs/ru/states.md`.
>
> The source of truth for the state definitions is `src/ir/islands.ts`. This document describes the
> live **task** states (islands), their work and their routes. The prompt and the tape are in
> `system_prompt.md` and `projection.md`; the IR in `ir.md`.
>
> The `general`, `plan` and `document` units are request-anchored: one goal, no `move`; they are
> described in `sessions.md`.

## 1. What a state is

A state is a frame of work, not a step and not a command. It has five parts:

1. a **subject** — the object or situation the state works on; the model records it as an optional,
   unverified note (`what`) when it enters the state;
2. a **goal** — the kind of work the state performs;
3. a **completion condition** — the observable condition rendered to the model as `Done when`;
4. an **instruction** — how to act in the state, rendered as `Plan`;
5. a **tool surface** — the tools the state admits.

The model names the state with `move`. The state kind supplies the goal, the completion condition,
the instruction and the tool surface. The state is open until the model replies with text; the
executor records that reply as the state's `stop` and the state becomes finished. The executor does
not decide when the state is finished and does not evaluate the reply.

The request is reference, not the goal. The state is never a turn, and a turn is never a state.

## 2. The states

### 2.1 Research

- **Subject:** a situation whose required result is derived from the material or the specification.
- **Goal:** `solve a situation: derive the required result from the material or the specification`.
- **`what`:** `solve a situation: derive the required result from the material or the specification`.
- **Done when:** `the task's required result exists in its declared form, is derived from the
  material or the specification, and matches what the material or the request contains`.
- **Method:** work from the material, not from its appearance. A read-only check on a copy is
  allowed and preferred over guessing; the material confirms the result. The material is evidence:
  change it only where the task says to (repair a damaged file, clean the repository); otherwise
  write the result beside it. The workspace root, repository status and environment are already on
  the tape.
- **Boundaries:** it does not look for a code defect (Patch) and does not build a new artifact from
  a specification (Construction).
- **Transitions:** → End when the result exists in its declared form and matches the material or
  the request; → Patch when the work is a code defect not yet located or fixed.
- **Examples:** `password-recovery` (recover a password from a damaged image), `db-wal-recovery`
  (decode a WAL and recover records), `crack-7z-hash` (recover a password from a 7z hash).

### 2.2 Patch

- **Subject:** an existing artifact with a defect.
- **Goal:** `find the defect in the existing artifact and make the change it needs`.
- **`what`:** `find the defect in the existing artifact and make the change it needs`.
- **Done when:** `the plan is complete: the error is found and fixed`.
- **Method:** one cycle — find the file with its coordinates and the cause, make the change the
  cause entails, then read the result. A change that does not hold is evidence about the cause:
  revise the cause and change again from it. Do not repeat the same edit and do not bypass an
  unestablished cause.
- **Boundaries:** the change is not limited to one file; a required file is not postponed to
  Verification. It does not derive a result from the material (Research), does not build a new
  artifact (Construction), and does not fabricate values. Reading a symbol's definition is fine;
  declaring a check as the task's acceptance is Verification's work.
- **Transitions:** → Verification when the change is applied and the edited lines read back;
  → Research when the work turns out to be a situation, not a defect.
- **Examples:** `fix-ocaml-gc` (`runtime/shared_heap.c`, `pool_sweep`, the common advance after
  the free branch uses `Whsize_hd` instead of `wh`), `fix-code-vulnerability` (`bottle.py`,
  `_hkey`/`_hval`), `fix-git`, `git-leak-recovery`.

### 2.3 Construction

- **Subject:** a new artifact or program.
- **Goal:** `build the new artifact from the specification or the material's behaviour`.
- **`what`:** `build the new artifact from the specification or the material's behaviour`.
- **Done when:** `the artifact exists, is derived from the specification or the material's
  behaviour, and the acceptance check passes`.
- **Method:** build the artifact from the specification or from the behaviour of the program the
  request names. Check it on representative inputs and fix it until the check passes. The material
  stays unchanged.
- **Boundaries:** it does not edit the source artifact (Patch); the material is a specification of
  behaviour, not an object of change; it does not substitute "the file was created" for a check.
- **Transitions:** → End when the artifact exists, is derived from the specification or behaviour,
  and the check passes; → Research when the check failed for a method reason: the method or
  specification did not hold; stay and repeat on an execution error.
- **Examples:** `regex-log`, `cobol-modernization`, `openssl-selfsigned-cert`,
  `log-summary-date-ranges`, `modernize-scientific-stack`.

### 2.4 Verification

- **Subject:** the changed artifact after Patch.
- **Goal:** `check the changed artifact against the goal's acceptance`.
- **`what`:** `check the changed artifact against the goal's acceptance`.
- **Done when:** `the acceptance holds: the acceptance command passes, or every declared constraint
  holds, and the result is derived from the source material, not synthesized`.
- **Method:** run the acceptance command if the workspace has one; otherwise check the declared
  constraints. Read the output itself: a zero exit status is not proof that the check passed. The
  acceptance is the one the request declares; do not substitute a criterion of your own. Do not
  change the artifact here, not with an edit and not with a shell command. If the check could not
  run because the environment is not ready — wrong working directory, missing build or test
  artifacts — fix the environment and retry.
- **Closing:** if the check passes, close the state; if it fails, close it too and put the failure
  in the result: the command or constraint, its exit status and the first real error, quoted. Do
  not interpret the code and do not propose a fix — that is the next state's work.
- **Boundaries:** it does not write the acceptance or build the check; it runs the ready one
  (project or external).
- **Transitions:** → End when the required result exists and the acceptance holds; → Patch when the
  acceptance fails.
- **Examples:** `fix-ocaml-gc` (`make -C testsuite one DIR=tests/basic`), `fix-code-vulnerability`
  (`pytest -rA` plus `report.jsonl`), `custom-memory-heap-crash` (release/debug plus valgrind
  without leaks).

### 2.5 End

- **Subject:** the request.
- **Goal:** complete the request.
- **Done when:** empty. End has no turns and no tools.
- **Method:** reply with the final report as text, with no tool calls. Read the tape — the request,
  the states the task passed, what each did, the files it changed, how the result was checked —
  and write the report in GitHub-flavored Markdown: what was done and where, how it was verified,
  and what remains open. Keep it as short as the result allows: lead with the answer and include
  only the detail the user needs; do not enumerate files, states or checks, and do not restate the
  request, unless the user asked for a detailed report.
- **Transition:** terminal state; closing it ends the request.

### Tool surface

The tools a state admits come from `Island.applies`:

| State | Admitted tools |
|---|---|
| Research | `read`, `grep`, `list`, `bash`, `webfetch`, `write` |
| Patch | `read`, `grep`, `list`, `bash`, `webfetch`, `edit`, `write`, `apply_patch` |
| Construction | `read`, `grep`, `list`, `bash`, `webfetch`, `edit`, `write`, `apply_patch` |
| Verification | `read`, `grep`, `list`, `bash`, `webfetch` |
| End | none |

`bash` is dual-use, but the state's instruction still bounds its work: Verification must not change
the artifact, and End has no tools at all.

## 3. Routes

The `next` graph in `src/ir/islands.ts` is:

| From | To | Condition |
|---|---|---|
| Research | End | the required result exists and matches the material or the request |
| Research | Patch | the work is a code defect not yet located or fixed |
| Patch | Verification | the change is applied and the edited lines read back |
| Patch | Research | the work turns out to be a situation, not a defect |
| Construction | End | the artifact exists, is derived, and the check passes |
| Construction | Research | the check failed for a method reason |
| Verification | End | the result exists and the acceptance holds |
| Verification | Patch | the acceptance fails |
| End | — | terminal |

A fresh request can start in `patch`, `research` or `construction`. `R → V` does not exist:
Verification follows a change, not a situation.

The `P → R` and `R → P` edges are corrective, not regular: they are used when the start
classification is wrong — Patch learns the work is a situation, or Research learns it is a code
defect. `V → P` is also corrective: a failed check may be a problem in the change or in the cause
it relied on, and both are revisited in Patch.

Typical routes:

- **Repair** — `P → V → End`.
- **Research** — `R → End`; the result check is part of Research's own work.
- **Construction** — `C → End`; a method failure may go to `R`.
- **Correction** — `P ⇄ R`, or `V → P` after a failed check.

## 4. Checking the result

A check is one of two kinds:

- **operational** — a command, test or build of the project (`pytest`, `make`, `valgrind`);
- **declarative** — declared conditions: path, format, exact value, provenance, behaviour.

When the task ships a ready check, Verification runs it. When the task does not, Research or
Construction write the check as part of their work: a checksum/hash, container metadata, a
structural invariant, known records, a test harness, a differential run, `openssl verify`.

The check is not a new state and not a source of truth. The model writes it; the reference is the
source material or the specification. The script must be independent of its own output, read the
source and the deliverable, and have a negative control. If no independent check exists, the state
does not close "on faith": it closes with an honest note about what was checked and what was not.

In a benchmark, the task's verifier runs outside the states. It is not part of the IR and is usually
invisible to the model; inside a state the model does the strongest available check and names its
limits honestly.
